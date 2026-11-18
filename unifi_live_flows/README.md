# UniFi Live Flows

Serves the UniFi gateway's **live (active) connections** to Home Assistant, the same list the Network app shows
under Flows > Live. The Network app reads them over a WebRTC data channel from the gateway; this app does the same
with libdatachannel (node-datachannel) and answers plain HTTP for Home Assistant.

## Why a login and not an API key

The live channel is set up with `cmd/devmgr build-ssh-session` and its offer arrives on the Network events
websocket. API keys are refused on that websocket (`api.err.LoginRequired`), and a read-only login is refused the
session commands (`api.err.NoPermission`). So it needs a **local UniFi account with an admin role in Network**
(no two-factor login). Use a dedicated account for this app.

## Options

| Option | Default | |
|---|---|---|
| `host` | `10.0.1.1` | gateway / console address |
| `site` | `default` | Network site name |
| `username`, `password` | | local admin account (the password is never logged) |
| `gateway_mac` | | optional; found from `stat/device` when empty |
| `page_size` | `100` | rows per `get_flows` request (the gateway returns at most 100 in total) |
| `max_flows` | `3000` | stop paging here |
| `idle_seconds` | `120` | close the WebRTC session after this long without a request |

## API (port 8099, app hostname from other containers)

- `GET /flows` -> `{snapshot_time, count, total, truncated, took_ms, records}`. Records are shaped like the v2
  `traffic-flows` log (source/destination with client names from `traffic-flows/enrich`, protocol, direction,
  application, traffic_data), plus `live: true`, `status`, `state`, `in_iface`, `out_iface`. Bytes and packets
  are totals since the connection started (`flow_start_time`). Cached for 3 s.
- `GET /health` -> `{ok, session, last_error}`

## Notes

- The gateway offers a LAN ICE candidate, so no TURN relay is used from inside the house.
- The gateway caps the live list at 100 connections (its top 100), whatever `page_size` is.
- The gateway counts routes between two of its LAN bridges (`br* -> br*`, e.g. Default -> CAM) the other way round;
  the app swaps those bytes/packets back (`counters_swapped: true`). Tunnel (`wgsts*`) and internet (`eth*`) routes
  are left as reported. Verified on `br0 -> br40`; other bridge pairs are assumed to behave the same.
- Long-lived connections rarely appear in the v2 flow log, which is why the log never showed active connections.
- aiortc (Python) completes ICE with the gateway but never DTLS; libdatachannel works.
- The Home Assistant side is `pyscript.unifi_flows` with `live: true` (ha-rmr repo).
