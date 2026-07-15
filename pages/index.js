import Head from "next/head";
import Script from "next/script";

export default function Home() {
  return (
    <>
      <Head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#f20d14" />
        <title>ONE TEN | Men's Fashion</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700;800;900&display=swap" rel="stylesheet" />
        <link rel="stylesheet" href="/styles.css?v=20260715-next" />
      </Head>
      <div id="root" />
      <Script src="https://unpkg.com/react@18/umd/react.production.min.js" strategy="beforeInteractive" />
      <Script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" strategy="beforeInteractive" />
      <Script src="/config.js?v=20260715-next" strategy="afterInteractive" />
      <Script src="/app.js?v=20260715-next" strategy="afterInteractive" />
    </>
  );
}
