import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Pixel Fixture Studio',
  description: 'Pixelblaze 3D mappings auswählen, prüfen und für MadMapper vorbereiten.',
  openGraph: {
    title: 'Pixel Fixture Studio',
    description: 'Pixelblaze 3D-Mappings auswählen und als MadMapper-6.1-Fixtures exportieren.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Pixel Fixture Studio mit drei LED-Panels' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Pixel Fixture Studio',
    description: 'Pixelblaze 3D-Mappings auswählen und als MadMapper-6.1-Fixtures exportieren.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
