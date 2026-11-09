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

    private const NEVER = 'never';

    private $actions;
    private $commands;

    public function __construct(array $actions, array $commands)
    {
        $this->actions = $actions;
        $this->commands = $commands;
    }

    public function capabilityFor(string $task, string $action): string
    {
        $name = $action === '' ? 'index' : $action;

        return $this->actions['*'][$name] ?? $this->actions[$task][$name] ?? self::DENY;
    }

    /**
     * @return string[] Client commands the interface must not offer to these capabilities
     */
    public function disabledCommands(array $capabilities): array
    {
        $disabled = [];

        foreach ($this->commands as $requirement => $commands) {
            if ($requirement === self::NEVER || !in_array($requirement, $capabilities, true)) {
                $disabled = array_merge($disabled, $commands);
            }
        }

        return $disabled;
    }
}
