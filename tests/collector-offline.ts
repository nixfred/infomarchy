// Preloaded only in collector fixture subprocesses: no HTTP or ping leaves tests.
globalThis.fetch = (async () => new Response('{"models":[]}', { headers: { "content-type": "application/json" } })) as typeof fetch;
const spawn = Bun.spawn.bind(Bun);
Bun.spawn = ((args: any, options: any) => spawn(Array.isArray(args) && ["ping", "gh"].includes(args[0]) ? ["/bin/true"] : args, options)) as typeof Bun.spawn;
