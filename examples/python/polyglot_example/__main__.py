from __future__ import annotations

import argparse
import asyncio
import os
import signal
import sys

from .transports import grpc_server, http, stdio


def main() -> None:
    parser = argparse.ArgumentParser(description="Independent Pi Polyglot example")
    parser.add_argument("--transport", choices=("stdio", "http", "grpc"), default="stdio")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be 1..65535")
    token = os.environ.get("POLYGLOT_TOKEN", "")
    if args.transport != "stdio" and (not token.strip() or any(ord(c) < 33 or ord(c) > 126 for c in token)):
        parser.error("POLYGLOT_TOKEN must be nonempty printable ASCII without spaces")

    async def run():
        if args.transport == "stdio":
            await stdio()
            return
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for signum in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(signum, stop.set)
        if args.transport == "http":
            await http(args.port, token, stop)
        else:
            await grpc_server(args.port, token, stop)

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    except Exception:
        print("Server failed; check local dependencies and port availability.", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
