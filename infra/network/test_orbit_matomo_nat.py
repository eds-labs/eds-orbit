import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import tempfile
import subprocess
import io
from contextlib import redirect_stderr

spec = importlib.util.spec_from_file_location("nat", Path(__file__).with_name("orbit-matomo-nat.py"))
nat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nat)


class MatomoNatTests(unittest.TestCase):
    def test_only_runtime_services_of_the_exact_application_are_sources(self):
        for role in ("api", "mcp", "worker"):
            self.assertTrue(nat.approved_name(f"{role}-{nat.APPLICATION}-20261111T124912"))
        for name in ("api-other-20261111T124912", f"web-{nat.APPLICATION}-20261111T124912",
                     f"postgres-{nat.APPLICATION}-20261111T124912", f"mcp-{nat.APPLICATION}-bad", "api; reboot"):
            self.assertFalse(nat.approved_name(name))

    def test_sources_are_bound_to_the_matching_application_bridge(self):
        pairs = nat.source_pairs({nat.APPLICATION: {"IPAddress": "172.20.18.9"},
                                 "unrelated": {"IPAddress": "172.20.2.3"}},
                                {nat.APPLICATION: "br-72ca51399f65"})
        self.assertEqual(pairs, {("br-72ca51399f65", "172.20.18.9")})
        with self.assertRaises(ValueError):
            nat.source_pairs({nat.APPLICATION: {"IPAddress": "8.8.8.8"}}, {nat.APPLICATION: "br-safe"})
        with self.assertRaises(ValueError):
            nat.source_pairs({nat.APPLICATION: {"IPAddress": "172.20.18.9"}}, {nat.APPLICATION: 'bad"; flush ruleset'})

    def test_rule_targets_only_public_https_and_the_existing_proxy(self):
        rule = nat.rules([("br-safe", "172.20.18.9")], replace=True)
        self.assertIn("iifname . ip saddr @orbit_sources ip daddr 176.31.234.10 tcp dport 443", rule)
        self.assertIn("dnat to 10.50.0.12:443", rule)
        self.assertIn('"br-safe" . 172.20.18.9', rule)
        self.assertNotIn("flush ruleset", rule)
        for line in rule.splitlines():
            self.assertIn("ip eds_orbit_matomo", line)

    def test_discovery_failure_closes_only_our_route(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(nat, "LOCK", Path(directory) / "lock"), patch.object(nat, "CACHE", Path(directory) / "cache"), patch.object(nat, "discover", side_effect=ValueError("bad discovery")), patch.object(nat, "run") as run, redirect_stderr(io.StringIO()):
                self.assertEqual(nat.main(), 1)
                run.assert_called_once_with("nft", "delete", "table", "ip", nat.TABLE, check=False)

    def test_failed_validation_never_applies_candidate_and_closes_our_route(self):
        def command(*args, **kwargs):
            if "--check" in args:
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 1 if "list" in args else 0, stdout="")
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(nat, "LOCK", Path(directory) / "lock"), patch.object(nat, "CACHE", Path(directory) / "cache"), patch.object(nat, "discover", return_value=[("br-safe", "172.20.18.9")]), patch.object(nat, "run", side_effect=command) as run, redirect_stderr(io.StringIO()):
                self.assertEqual(nat.main(), 1)
                applied = [call for call in run.call_args_list if call.args == ("nft", "--file", "-")]
                self.assertEqual(applied, [])
                self.assertEqual(run.call_args.args, ("nft", "delete", "table", "ip", nat.TABLE))

    def test_empty_discovery_does_not_leave_any_allowed_source(self):
        rule = nat.rules([])
        self.assertIn("add set ip eds_orbit_matomo orbit_sources", rule)
        self.assertNotIn("add element", rule)


if __name__ == "__main__":
    unittest.main()
