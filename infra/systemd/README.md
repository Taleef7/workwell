# Running WorkWell as a host service (systemd)

This directory holds an **example** systemd unit, [`workwell.service`](./workwell.service),
for running the WorkWell stack on a self-hosted host or VM so that:

- the app **starts automatically on boot** (survives a server reboot), and
- it is supervised by `systemctl` (start / stop / status / logs).

It is the reference Doug asked for. It is **not** what runs the live demo — the
`os.mieweb.org` stack runs on MIE's Create-a-Container platform, where the platform owns
host-reboot recovery (see [`docs/DEPLOY.md` → "Service startup & reboot policy"](../../docs/DEPLOY.md)).

## How the layers fit together

| Concern | Owned by |
|---|---|
| A single container crashing → restart it | `restart: unless-stopped` in [`infra/docker-compose.yml`](../docker-compose.yml) |
| Host reboots → bring the whole stack back up | this systemd unit (`systemctl enable`) **+** `systemctl enable docker` |
| Live `os.mieweb.org` deployment | MIE Create-a-Container platform (verify its reboot policy with MIE ops) |

## Quick start

```bash
# 1. Docker must itself start on boot
sudo systemctl enable docker

# 2. Place the repo's infra/ where the unit expects it (WorkingDirectory)
sudo mkdir -p /opt/workwell && sudo cp -r infra /opt/workwell/

# 3. Install + enable the unit
sudo cp infra/systemd/workwell.service /etc/systemd/system/workwell.service
sudo systemctl daemon-reload
sudo systemctl enable --now workwell

# 4. Verify
systemctl status workwell
docker compose -f /opt/workwell/infra/docker-compose.yml ps
```

## Verify reboot recovery

```bash
sudo reboot
# after it comes back up:
systemctl status workwell                 # should be active (exited), RemainAfterExit
docker compose -f /opt/workwell/infra/docker-compose.yml ps   # all services Up
```

## Logs

```bash
journalctl -u workwell -f                  # unit start/stop output
docker compose -f /opt/workwell/infra/docker-compose.yml logs -f   # app logs
```
