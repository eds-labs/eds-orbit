"use client";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import type { Locale } from "@/lib/i18n";
import { Button } from "@/components/ui/primitives";
import { centerText } from "../texts";

/**
 * Points to the page where AI settings are still edited. The AI forms stay
 * there until they save safely inside the center; system, organization and
 * project scopes share this pointer.
 */
export function AiLinkPanel({ href, locale }: { href: string; locale: Locale }) {
  const text = centerText(locale);
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <p>{text("aiLinkBody")}</p>
        </div>
        <Button asChild variant="outline">
          <Link href={href}>
            <Sparkles data-icon="inline-start" />
            {text("aiLinkAction")}
          </Link>
        </Button>
      </div>
    </section>
  );
}
