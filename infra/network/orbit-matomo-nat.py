#!/usr/bin/env python3
"""VM102-only loopback NAT for Orbit's existing public Matomo HTTPS endpoint."""
import fcntl
import ipaddress
import json
from pathlib import Path
import re
import subprocess
import sys

APPLICATION = "q9xduufgytnsqmk6wurfvb4l"
TABLE = "eds_orbit_matomo"
PUBLIC_ADDRESS = "176.31.234.10"
PROXY_ADDRESS = "10.50.0.12"
CACHE = Path("/run/eds-orbit-matomo-nat.json")
LOCK = Path("/run/eds-orbit-matomo-nat.lock")
TARGET = re.compile(rf"(?:api|mcp|worker)-{APPLICATION}-[0-9]{{8}}T[0-9]{{6}}")
NETWORKS = {APPLICATION, *(APPLICATION + "_" + name for name in ("egress", "database", "frontend"))}


def run(*args, input=None, check=True):
    return subprocess.run(args, input=input, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, check=check)


def approved_name(name):
    return TARGET.fullmatch(name) is not None


def source_pairs(networks, bridges):
    pairs = set()
    for name, info in networks.items():
        if name not in NETWORKS or not info.get("IPAddress"):
            continue
        address = ipaddress.IPv4Address(info["IPAddress"])
        if not address.is_private:
            raise ValueError("non-private container source")
        bridge = bridges[name]
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", bridge):
            raise ValueError("invalid bridge")
        pairs.add((bridge, str(address)))
    return pairs


def discover():
    names = run("docker", "ps", "--format", "{{.Names}}").stdout.splitlines()
    pairs, bridges = set(), {}
    for name in filter(approved_name, names):
        networks = json.loads(run("docker", "inspect", "--format",
                                  "{{json .NetworkSettings.Networks}}", name).stdout)
        for network in networks.keys() & NETWORKS:
            if network not in bridges:
                network_id = run("docker", "network", "inspect", "--format", "{{.Id}}", network).stdout.strip()
                if not re.fullmatch(r"[a-f0-9]{64}", network_id):
                    raise ValueError("invalid network id")
                options = json.loads(run("docker", "network", "inspect", "--format", "{{json .Options}}", network).stdout) or {}
                bridges[network] = options.get("com.docker.network.bridge.name") or "br-" + network_id[:12]
        pairs.update(source_pairs(networks, bridges))
    return sorted(pairs)


def rules(pairs, replace=False):
    lines = [f"delete table ip {TABLE}"] if replace else []
    lines += [f"add table ip {TABLE}", f"add set ip {TABLE} orbit_sources {{ type ifname . ipv4_addr; }}"]
    if pairs:
        elements = ", ".join(f'"{bridge}" . {address}' for bridge, address in pairs)
        lines.append(f"add element ip {TABLE} orbit_sources {{ {elements} }}")
    lines += [
        f"add chain ip {TABLE} prerouting {{ type nat hook prerouting priority -110; policy accept; }}",
        f"add rule ip {TABLE} prerouting iifname . ip saddr @orbit_sources ip daddr {PUBLIC_ADDRESS} tcp dport 443 counter dnat to {PROXY_ADDRESS}:443",
    ]
    return "\n".join(lines) + "\n"


def main():
    # Also serialize manual invocations with the refresh timer.
    with open(LOCK, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            pairs = discover()
            state = json.dumps({"sources": pairs, "public": PUBLIC_ADDRESS, "proxy": PROXY_ADDRESS, "version": 1})
            exists = run("nft", "list", "table", "ip", TABLE, check=False).returncode == 0
            if exists and CACHE.exists() and CACHE.read_text() == state:
                return 0
            candidate = rules(pairs, replace=exists)
            run("nft", "--check", "--file", "-", input=candidate)
            # nft applies one atomic transaction; unrelated tables are untouched.
            run("nft", "--file", "-", input=candidate)
            CACHE.write_text(state)
            print("ORBIT_MATOMO_NAT_REFRESHED", len(pairs))
            return 0
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            # Discovery failure closes only this optional route, never broadens it.
            run("nft", "delete", "table", "ip", TABLE, check=False)
            CACHE.unlink(missing_ok=True)
            print("ORBIT_MATOMO_NAT_REFRESH_FAILED", file=sys.stderr)
            return 1


if __name__ == "__main__":
    sys.exit(main())
