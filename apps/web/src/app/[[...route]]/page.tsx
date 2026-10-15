"use client";
// A client page: the registry holds components, which a server page could not
// pass to the shell. Next.js still never reads the database (ADR 0001).
import { Orbit } from "@/components/orbit";
import { webRegistry } from "@/modules/registry";
export default function Page() {
  return <Orbit registry={webRegistry} />;
}
