"use client"

import { AppProvider } from "@/lib/app-context"
import { AppShell } from "@/components/app-shell"
import { Toaster } from "sonner"

export default function Home() {
  return (
    <AppProvider>
      <AppShell />
      <Toaster
        position="bottom-center"
        toastOptions={{
          style: {
            borderRadius: "14px",
            fontSize: "14px",
            fontFamily: "inherit",
          },
        }}
      />
    </AppProvider>
  )
}
