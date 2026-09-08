#!/usr/bin/env python3
# 0.0.0.0:9119 -> 127.0.0.1:9118. The Hermes dashboard demands a login on any non-loopback bind,
# and Caddy cannot reach a loopback bind in another container. Caddy keeps the LAN as the boundary.
import asyncio
async def pipe(r, w):
    try:
        while True:
            d = await r.read(65536)
            if not d: break
            w.write(d); await w.drain()
    except Exception: pass
    finally:
        try: w.close()
        except Exception: pass
async def handle(cr, cw):
    try: ur, uw = await asyncio.open_connection("127.0.0.1", 9118)
    except Exception:
        cw.close(); return
    await asyncio.gather(pipe(cr, uw), pipe(ur, cw))
async def main():
    s = await asyncio.start_server(handle, "0.0.0.0", 9119)
    async with s: await s.serve_forever()
asyncio.run(main())
