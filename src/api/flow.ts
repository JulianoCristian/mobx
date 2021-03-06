import { action, fail, noop } from "../internal"

let generatorId = 0

export type CancellablePromise<T> = Promise<T> & { cancel(): void }

export interface FlowYield {
    // fake, only for typing
    "!!flowYield": undefined
}

export interface FlowReturn<T> {
    // fake, only for typing
    "!!flowReturn": T
}

// we skip promises that are the result of yielding promises (except if they use flowReturn)
export type FlowReturnType<R> = IfAllAreFlowYieldThenVoid<
    R extends FlowReturn<infer FR>
        ? FR extends Promise<infer FRP> ? FRP : FR
        : R extends Promise<any> ? FlowYield : R
>

// we extract yielded promises from the return type
export type IfAllAreFlowYieldThenVoid<R> = Exclude<R, FlowYield> extends never
    ? void
    : Exclude<R, FlowYield>

export function flow<R, Args extends any[]>(
    generator: (...args: Args) => IterableIterator<R>
): (...args: Args) => CancellablePromise<FlowReturnType<R>> {
    if (arguments.length !== 1)
        fail(process.env.NODE_ENV && `Flow expects one 1 argument and cannot be used as decorator`)
    const name = generator.name || "<unnamed flow>"

    // Implementation based on https://github.com/tj/co/blob/master/index.js
    return function() {
        const ctx = this
        const args = arguments
        const runId = ++generatorId
        const gen = action(`${name} - runid: ${runId} - init`, generator).apply(
            ctx,
            (args as any) as Args
        )
        let rejector: (error: any) => void
        let pendingPromise: CancellablePromise<any> | undefined = undefined

        const promise = new Promise<R>(function(resolve, reject) {
            let stepId = 0
            rejector = reject

            function onFulfilled(res: any) {
                pendingPromise = undefined
                let ret
                try {
                    ret = action(`${name} - runid: ${runId} - yield ${stepId++}`, gen.next).call(
                        gen,
                        res
                    )
                } catch (e) {
                    return reject(e)
                }

                next(ret)
            }

            function onRejected(err: any) {
                pendingPromise = undefined
                let ret
                try {
                    ret = action(`${name} - runid: ${runId} - yield ${stepId++}`, gen.throw!).call(
                        gen,
                        err
                    )
                } catch (e) {
                    return reject(e)
                }
                next(ret)
            }

            function next(ret: any) {
                if (ret && typeof ret.then === "function") {
                    // an async iterator
                    ret.then(next, reject)
                    return
                }
                if (ret.done) return resolve(ret.value)
                pendingPromise = Promise.resolve(ret.value) as any
                return pendingPromise!.then(onFulfilled, onRejected)
            }

            onFulfilled(undefined) // kick off the process
        }) as any

        promise.cancel = action(`${name} - runid: ${runId} - cancel`, function() {
            try {
                if (pendingPromise) cancelPromise(pendingPromise)
                // Finally block can return (or yield) stuff..
                const res = gen.return!()
                // eat anything that promise would do, it's cancelled!
                const yieldedPromise = Promise.resolve(res.value)
                yieldedPromise.then(noop, noop)
                cancelPromise(yieldedPromise) // maybe it can be cancelled :)
                // reject our original promise
                rejector(new Error("FLOW_CANCELLED"))
            } catch (e) {
                rejector(e) // there could be a throwing finally block
            }
        })
        return promise as CancellablePromise<FlowReturnType<R>>
    }
}

function cancelPromise(promise) {
    if (typeof promise.cancel === "function") promise.cancel()
}
