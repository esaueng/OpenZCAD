import { useEffect, useMemo, useRef, useState } from 'react';
import { QrCode } from 'lucide-react';
import { encodeQr, qrSvgPath } from '../../lib/e2ee/qrCode';
import { deviceApprovalLink } from '../../lib/e2ee/deviceApprovalLink';

/**
 * What a new device shows while it waits for approval. The QR code carries
 * the approval link (`#approve-device=…`), so any phone's own camera app
 * opens it straight into OpenZCAD's approval; an in-app scanner reads the
 * same link. The code under it is the same value, for typing.
 */
export function ScanCodeDisplay({ code }: { code: string }) {
  const { path, size, link } = useMemo(() => {
    const url = deviceApprovalLink(code);
    try {
      return { ...qrSvgPath(encodeQr(url)), link: url };
    } catch {
      // A self-hosted origin too long for the encoder: the bare code still
      // scans in OpenZCAD's own scanner, just not from a camera app.
      return { ...qrSvgPath(encodeQr(code)), link: null };
    }
  }, [code]);
  return (
    <div className="encryption-scan">
      <svg
        className="encryption-qr"
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label="Device approval QR code"
        shapeRendering="crispEdges"
        data-link={link ?? undefined}
      >
        <rect width={size} height={size} fill="#fff" />
        <path d={path} fill="#000" />
      </svg>
      <code className="encryption-code" aria-label="Device approval code">
        {code}
      </code>
    </div>
  );
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

/** Camera scanning where the browser has a QR detector; typing works anywhere. */
export function QrScanner({ onCode }: { onCode(code: string): void }) {
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const Detector = (
    globalThis as {
      BarcodeDetector?: new (options: {
        formats: string[];
      }) => BarcodeDetectorLike;
    }
  ).BarcodeDetector;

  useEffect(() => {
    if (!scanning || !Detector) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    const detector = new Detector({ formats: ['qr_code'] });
    void navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment' } })
      .then(async (media) => {
        stream = media;
        const video = videoRef.current;
        if (!video || stopped) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        video.srcObject = media;
        await video.play();
        while (!stopped) {
          const [found] = await detector.detect(video).catch(() => []);
          if (stopped) return;
          if (found?.rawValue) {
            onCode(found.rawValue);
            setScanning(false);
            return;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 300));
        }
      })
      .catch(() => setScanning(false));
    return () => {
      stopped = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [Detector, onCode, scanning]);

  if (!Detector || !navigator.mediaDevices) return null;
  return scanning ? (
    <div className="encryption-camera">
      <video ref={videoRef} muted playsInline aria-label="Camera" />
      <button
        className="secondary"
        type="button"
        onClick={() => setScanning(false)}
      >
        Stop camera
      </button>
    </div>
  ) : (
    <button
      className="secondary"
      type="button"
      onClick={() => setScanning(true)}
    >
      <QrCode size={14} aria-hidden="true" />
      Scan with camera
    </button>
  );
}
