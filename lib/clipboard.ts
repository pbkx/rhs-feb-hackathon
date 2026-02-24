"use client"

export async function copyTextToClipboard(text: string) {
  if (
    typeof window === "undefined" ||
    !window.isSecureContext ||
    !navigator.clipboard?.writeText
  ) {
    throw new Error("Clipboard API unavailable")
  }

  await navigator.clipboard.writeText(text)
}
