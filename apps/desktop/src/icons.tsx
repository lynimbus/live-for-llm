import { Canvas, type CanvasRenderingContext2D, token } from "nsh";

export interface IconProps {
  readonly size?: number;
  readonly colorToken?: "foreground" | "muted-foreground" | "primary-foreground";
}

function strokeCanvas(
  size: number,
  colorToken: "foreground" | "muted-foreground" | "primary-foreground",
  render: (cx: CanvasRenderingContext2D, s: number) => void,
) {
  return (
    <Canvas
      style={{ width: size, height: size, flexShrink: 0 }}
      draw={(cx, box) => {
        const s = Math.min(box.width, box.height);
        cx.strokeStyle = token(colorToken);
        cx.fillStyle = token(colorToken);
        cx.lineWidth = 1.6;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        cx.beginPath();
        render(cx, s);
      }}
    />
  );
}

/** ChatGPT-style left panel toggle icon. */
export function SidebarIcon(props: IconProps = {}) {
  return strokeCanvas(props.size ?? 18, props.colorToken ?? "muted-foreground", (cx, s) => {
    cx.roundRect(s * 0.14, s * 0.17, s * 0.72, s * 0.66, s * 0.14);
    cx.moveTo(s * 0.38, s * 0.17);
    cx.lineTo(s * 0.38, s * 0.83);
    cx.stroke();
  });
}

/** ChatGPT-style new conversation / compose icon. */
export function NewChatIcon(props: IconProps = {}) {
  return strokeCanvas(props.size ?? 18, props.colorToken ?? "foreground", (cx, s) => {
    // Open-corner rounded square
    cx.moveTo(s * 0.52, s * 0.18);
    cx.lineTo(s * 0.28, s * 0.18);
    cx.quadraticCurveTo(s * 0.16, s * 0.18, s * 0.16, s * 0.3);
    cx.lineTo(s * 0.16, s * 0.72);
    cx.quadraticCurveTo(s * 0.16, s * 0.84, s * 0.28, s * 0.84);
    cx.lineTo(s * 0.7, s * 0.84);
    cx.quadraticCurveTo(s * 0.82, s * 0.84, s * 0.82, s * 0.72);
    cx.lineTo(s * 0.82, s * 0.48);
    // Diagonal pen stroke
    cx.moveTo(s * 0.46, s * 0.54);
    cx.lineTo(s * 0.82, s * 0.18);
    cx.stroke();
  });
}

/** Background tasks checklist / runner icon. */
export function TasksIcon(props: IconProps = {}) {
  return strokeCanvas(props.size ?? 18, props.colorToken ?? "muted-foreground", (cx, s) => {
    cx.roundRect(s * 0.14, s * 0.17, s * 0.72, s * 0.66, s * 0.14);
    cx.moveTo(s * 0.62, s * 0.17);
    cx.lineTo(s * 0.62, s * 0.83);
    cx.moveTo(s * 0.26, s * 0.42);
    cx.lineTo(s * 0.5, s * 0.42);
    cx.moveTo(s * 0.26, s * 0.58);
    cx.lineTo(s * 0.46, s * 0.58);
    cx.stroke();
  });
}

/** Upward send arrow inside ChatGPT-style circular submit button. */
export function SendArrowIcon(props: IconProps = {}) {
  return strokeCanvas(props.size ?? 16, props.colorToken ?? "primary-foreground", (cx, s) => {
    cx.lineWidth = 2;
    cx.moveTo(s * 0.5, s * 0.8);
    cx.lineTo(s * 0.5, s * 0.22);
    cx.moveTo(s * 0.24, s * 0.46);
    cx.lineTo(s * 0.5, s * 0.2);
    cx.lineTo(s * 0.76, s * 0.46);
    cx.stroke();
  });
}

/** Disclosure chevron for expandable task rows. */
export function ChevronIcon(props: IconProps & { readonly expanded: boolean | (() => boolean) }) {
  return strokeCanvas(props.size ?? 14, props.colorToken ?? "muted-foreground", (cx, s) => {
    const isExp = typeof props.expanded === "function" ? props.expanded() : props.expanded;
    if (isExp) {
      cx.moveTo(s * 0.25, s * 0.36);
      cx.lineTo(s * 0.5, s * 0.64);
      cx.lineTo(s * 0.75, s * 0.36);
    } else {
      cx.moveTo(s * 0.36, s * 0.25);
      cx.lineTo(s * 0.64, s * 0.5);
      cx.lineTo(s * 0.36, s * 0.75);
    }
    cx.stroke();
  });
}

/** Minimal close '×' icon for secondary screens. */
export function CloseIcon(props: IconProps = {}) {
  return strokeCanvas(props.size ?? 16, props.colorToken ?? "muted-foreground", (cx, s) => {
    cx.moveTo(s * 0.25, s * 0.25);
    cx.lineTo(s * 0.75, s * 0.75);
    cx.moveTo(s * 0.75, s * 0.25);
    cx.lineTo(s * 0.25, s * 0.75);
    cx.stroke();
  });
}
