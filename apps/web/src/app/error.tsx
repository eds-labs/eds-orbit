"use client";
import { Alert, Button } from "@/components/ui/primitives";
export default function WorkspaceError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="boot">
      <h1>The workspace could not be displayed.</h1>
      <Alert kind="error">
        Your changes have not been submitted by this error screen. Try loading
        the workspace again.
      </Alert>
      <Button onClick={reset}>Try again</Button>
      <a className="text-link" href="/">
        Return to overview
      </a>
    </main>
  );
}
