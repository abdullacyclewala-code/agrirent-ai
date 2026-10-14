import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Eraser, PenLine } from "lucide-react";
import { Button } from "../ui/Primitives.jsx";

/**
 * SignaturePad — the attestation gesture.
 *
 * Deliberately a finger-drawn signature rather than a checkbox: the whole
 * point of the two-signature design (docs/PHASE7 §2) is that each party
 * separately attests to what they saw, and a drawn mark plus a written
 * statement is the smallest thing that reads as an act rather than a click.
 *
 * The PNG is stored alongside the statement; the STATEMENT is the binding part
 * and lives in `report_signatures.statement_text`, so the record is legible
 * even if the image is ever lost.
 */
export default function SignaturePad({ statement, onSigned, busy = false, signLabel }) {
  const { t } = useTranslation();
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  const setup = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#251c11";
  }, []);

  useEffect(() => {
    setup();
    const onResize = () => {
      setHasInk(false);
      setup();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [setup]);

  const point = (event) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const touch = event.touches?.[0] || event.changedTouches?.[0];
    return {
      x: (touch ? touch.clientX : event.clientX) - rect.left,
      y: (touch ? touch.clientY : event.clientY) - rect.top,
    };
  };

  const start = (event) => {
    event.preventDefault();
    drawingRef.current = true;
    const ctx = canvasRef.current.getContext("2d");
    const { x, y } = point(event);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const move = (event) => {
    if (!drawingRef.current) return;
    event.preventDefault();
    const ctx = canvasRef.current.getContext("2d");
    const { x, y } = point(event);
    ctx.lineTo(x, y);
    ctx.stroke();
    if (!hasInk) setHasInk(true);
  };

  const end = () => {
    drawingRef.current = false;
  };

  const clear = () => {
    const canvas = canvasRef.current;
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  };

  const sign = async () => {
    const canvas = canvasRef.current;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    onSigned(blob);
  };

  return (
    <div className="rounded-2xl border border-line bg-paper p-4">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-mut">
        <PenLine size={13} /> {t("trust.signTitle")}
      </div>
      <p className="mb-3 text-sm text-ink-2">{statement}</p>
      <canvas
        ref={canvasRef}
        onMouseDown={start}
        onMouseMove={move}
        onMouseUp={end}
        onMouseLeave={end}
        onTouchStart={start}
        onTouchMove={move}
        onTouchEnd={end}
        className="h-36 w-full touch-none rounded-xl border border-dashed border-line-2 bg-card"
      />
      <div className="mt-3 flex items-center gap-3">
        <Button onClick={sign} disabled={!hasInk || busy}>
          {signLabel || t("trust.signButton")}
        </Button>
        <Button variant="ghost" onClick={clear} disabled={!hasInk || busy}>
          <Eraser size={14} /> {t("trust.clearSignature")}
        </Button>
        {!hasInk && <span className="text-xs text-mut2">{t("trust.signHint")}</span>}
      </div>
    </div>
  );
}
