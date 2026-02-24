import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'StreamMaps',
  description: 'A website which analyzes stream connection barriers',
}

export const viewport: Viewport = {
  themeColor: '#D1F1FB',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="font-sans antialiased overflow-hidden">
        {children}
      </body>
    </html>
  )
}
