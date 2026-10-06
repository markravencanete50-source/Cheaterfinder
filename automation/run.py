"""Entrypoint for the local automation service.

Do not replace the host with 0.0.0.0.  Express is the public application API;
this process accepts only authenticated loopback traffic from that backend.
"""

import uvicorn


if __name__ == "__main__":
    uvicorn.run("app.main:app", host="127.0.0.1", port=8787, reload=False)
