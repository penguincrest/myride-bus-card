# MyRide Bus Card

A Lovelace card for the [My Ride K-12](https://github.com/penguincrest/ha-myride) Home Assistant integration. It shows the school bus run that matters right now — the morning run before `switch_time`, the afternoon run after — with:

- the bus status (On Time / Early / Late / Completed) as a coloured pill
- a live **"Arriving in N min"** countdown, or the scheduled time before the bus starts its route
- the next stop and how many stops are left
- distance to the stop and whether the bus is approaching
- the driver, and how fresh the bus GPS position is

Tap the header to open the bus tracker's details.

The card uses only the documented Lovelace custom-card API, has no dependencies, and needs no build step.

## Install

**Settings → Marketplace → Add from link** → `https://github.com/penguincrest/myride-bus-card`, type **Dashboard**, then install. The dashboard resource is registered for you.

## Configure

Add **MyRide Bus** from the card picker — it fills in the My Ride K-12 entities it finds and has a visual editor — or in YAML:

```yaml
type: custom:myride-bus-card
title: Theo's Bus
switch_time: "12:00"
status_am: sensor.theo_googe_bus_status_am
next_stop_am: sensor.theo_googe_next_bus_stop_am
distance_am: sensor.theo_googe_bus_distance_to_next_stop_am
tracker_am: device_tracker.theo_googe_bus_am
status_pm: sensor.theo_googe_bus_status_pm
next_stop_pm: sensor.theo_googe_next_bus_stop_pm
distance_pm: sensor.theo_googe_bus_distance_to_next_stop_pm
tracker_pm: device_tracker.theo_googe_bus_pm
```

| Option | Description |
|---|---|
| `title` | Card heading (default "School Bus") |
| `switch_time` | Time of day from which the PM run is shown (default `12:00`) |
| `status_am` / `status_pm` | Bus status sensors |
| `next_stop_am` / `next_stop_pm` | Next bus stop sensors |
| `distance_am` / `distance_pm` | Distance to next stop sensors (optional) |
| `tracker_am` / `tracker_pm` | Bus device trackers (optional; used for GPS age and the tap action) |

Configure at least one run. Pair the card with a built-in **Map** card showing the trackers to see where the bus is.

## Times

My Ride K-12 reports planned stop times as local time of day and live ETAs as UTC. The card converts both itself, so the countdown is right whether or not your integration normalizes them.

## License

MIT
