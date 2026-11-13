"use client";
import Link from "next/link";
import { Lock } from "lucide-react";
import type { Locale } from "@/lib/i18n";
import { Alert, Button, Empty } from "@/components/ui/primitives";
import { centerText } from "@/platform/settings-center/texts";

/**
 * What an old settings address shows when it cannot lead to the settings
 * center (P54-D3): the member cannot open the area ("closed"), or their
 * capabilities could not be read ("failed"). The old page never renders.
 */
export function OldAddressScreen({
  kind,
  locale,
  onRetry,
}: {
  kind: "closed" | "failed";
  locale: Locale;
  /** Requests the capabilities again. */
  onRetry: () => void;
}) {
  const t = centerText(locale);
  if (kind === "failed")
    return (
      <div className="not-found">
        <Alert kind="error">{t("oldAddressFailed")}</Alert>
        <Button onClick={onRetry}>{t("oldAddressRetry")}</Button>
      </div>
    );
  return (
    <div className="not-found">
      <Empty
        icon={Lock}
        title={t("notPermittedTitle")}
        description={t("oldAddressClosedBody")}
      >
        <Button asChild variant="outline">
          <Link href="/">{t("oldAddressHome")}</Link>
        </Button>
      </Empty>
    </div>
  );
}
