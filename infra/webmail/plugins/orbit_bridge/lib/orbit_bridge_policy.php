<?php

/**
 * Maps Roundcube task/action pairs to the capability they require.
 *
 * The table is an allowlist compared by exact string. Roundcube also dispatches
 * "folder_purge" and "DELETE" to the same handlers as "folder-purge" and "delete",
 * so normalising names here would widen the policy. Unknown names are denied.
 */
class orbit_bridge_policy
{
    public const DENY = 'deny';

    private $actions;

    public function __construct(array $actions)
    {
        $this->actions = $actions;
    }

    public function capabilityFor(string $task, string $action): string
    {
        $name = $action === '' ? 'index' : $action;

        return $this->actions['*'][$name] ?? $this->actions[$task][$name] ?? self::DENY;
    }
}
