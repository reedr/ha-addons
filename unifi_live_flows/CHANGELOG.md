# Changelog

## 0.1.3 (2026-11-18)

- Empty `hostnames` entries dropped (PiAware's UDP feed had `[""]`).

## 0.1.2 (2026-11-18)

- Destination names from the gateway's own DNS-snooped `hostnames` on each live flow (about 60% of them),
  ahead of `traffic-flows/enrich` names.

## 0.1.1 (2026-11-17)

- Bytes and packets swapped back for routes between two LAN bridges (`br* -> br*`), which the gateway counts
  the other way round (verified on Default -> CAM camera pulls); records carry `counters_swapped`.

## 0.1.0 (2026-11-17)

- First version: local admin login, WebRTC `trafficflow` session via node-datachannel, `get_flows` paging,
  names from `traffic-flows/enrich`, HTTP `/flows` and `/health`, idle session close.
