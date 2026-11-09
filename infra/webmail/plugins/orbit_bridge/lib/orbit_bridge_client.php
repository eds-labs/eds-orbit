<?php

/**
 * HTTP client for the internal Orbit webmail bridge.
 *
 * Every endpoint is a POST with a JSON body and bearer authentication. Any transport,
 * status or decoding failure returns null so callers can fail closed.
 */
class orbit_bridge_client
{
    private const TIMEOUT_SECONDS = 5;

    private $http;
    private $baseUrl;
    private $secret;

    public function __construct($http, string $baseUrl, string $secret)
    {
        $this->http = $http;
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->secret = $secret;
    }

    public function consumeHandoff(string $token, string $origin): ?array
    {
        return $this->post('/v1/handoff/consume', ['token' => $token, 'origin' => $origin]);
    }

    public function authorize(string $handle, string $task, string $action): ?array
    {
        return $this->post('/v1/session/authorize', [
            'handle' => $handle,
            'task' => $task,
            'action' => $action,
        ]);
    }

    public function barrier(string $handle, array $request): ?array
    {
        return $this->post('/v1/session/barrier', ['handle' => $handle] + $request);
    }

    public function endSession(string $handle, string $reason): void
    {
        $this->post('/v1/session/end', ['handle' => $handle, 'reason' => $reason]);
    }

    private function post(string $path, array $body): ?array
    {
        try {
            $response = $this->http->post($this->baseUrl . $path, [
                'headers' => ['Authorization' => 'Bearer ' . $this->secret],
                'json' => $body,
                'http_errors' => false,
                'timeout' => self::TIMEOUT_SECONDS,
                'connect_timeout' => self::TIMEOUT_SECONDS,
            ]);
        } catch (\Throwable $e) {
            rcube::raise_error(['code' => 500, 'message' => 'orbit_bridge: bridge unreachable'], true, false);
            return null;
        }

        if ($response->getStatusCode() !== 200) {
            return null;
        }

        $data = json_decode((string) $response->getBody(), true);

        return is_array($data) ? $data : null;
    }
}
