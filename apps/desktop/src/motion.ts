import { createMotion, LayoutAnimation, type ViewStyle } from "nsh";

/** Triggers a smooth native spring layout transition before state toggles or list changes. */
export function animateLayout(preset: "spring" | "ease" = "spring"): void {
  try {
    if (preset === "spring") {
      LayoutAnimation.configureNext({
        duration: 220,
        create: { type: "spring", springDamping: 0.84, property: "opacity", duration: 190 },
        update: { type: "spring", springDamping: 0.86, duration: 220 },
        delete: { type: "easeOut", property: "opacity", duration: 140 },
      });
    } else {
      LayoutAnimation.easeInEaseOut();
    }
  } catch {
    // Ignore in environments without layout animation driver.
  }
}

/** Creates an entrance motion helper with graceful fallback. */
export function createEnterMotion(
  preset: "fadeInUp" | "fadeInRight" | "fadeInLeft" | "fadeInDown" | "popIn",
  duration = 200,
) {
  return createMotion({ enter: preset, duration });
}

export const BUTTON_MOTION_STYLE: ViewStyle = {
  transitionProperty: "all",
  transitionDuration: 140,
  transitionTimingFunction: "ease-out",
};

export const BUTTON_ACTIVE_STYLE: ViewStyle = {
  transform: [{ scale: 0.97 }],
  opacity: 0.9,
};

export const CARD_ELEVATION_STYLE: ViewStyle = {
  boxShadow: [{ x: 0, y: 2, blur: 10, color: "#00000018" }],
};
