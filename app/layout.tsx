import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Pixel Fixture Studio',
  description: 'Turn Pixelblaze and Marimapper LED scans into aligned MadMapper fixtures.',
  icons: { icon: '/favicon.svg' },
  openGraph: {
    title: 'Pixel Fixture Studio',
    description: 'Turn Pixelblaze and Marimapper LED scans into aligned MadMapper 6.1 fixtures.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Pixel Fixture Studio showing three LED panels' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Pixel Fixture Studio',
    description: 'Turn Pixelblaze and Marimapper LED scans into aligned MadMapper 6.1 fixtures.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
