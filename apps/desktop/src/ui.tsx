import { Text } from "nsh";
import { Button } from "nsh/base";
import { BUTTON_ACTIVE_STYLE, BUTTON_MOTION_STYLE } from "./motion.ts";

/** High-contrast pill button used across filters, tabs, model pickers, and policies. */
export function SelectablePill(props: {
  readonly label: string | (() => string);
  readonly selected: () => boolean;
  readonly testID?: string;
  readonly compact?: boolean;
  readonly onPress: () => void;
}) {
  const resolveLabel = () =>
    typeof props.label === "function" ? props.label() : props.label;

  return (
    <Button
      testID={props.testID}
      selected={props.selected()}
      onPress={props.onPress}
      class={
        props.compact
          ? "group px-2.5 py-1 rounded-md bg-secondary selected:bg-primary border border-transparent selected:border-primary"
          : "group px-3 py-1.5 rounded-lg bg-secondary selected:bg-primary border border-transparent selected:border-primary"
      }
      style={[BUTTON_MOTION_STYLE, { maxWidth: "100%", flexShrink: 1 }]}
      hoverStyle={{ opacity: 0.92 }}
      activeStyle={BUTTON_ACTIVE_STYLE}
    >
      <Text
        class={
          props.selected()
            ? "text-xs font-semibold text-primary-foreground"
            : "text-xs font-medium text-secondary-foreground"
        }
        style={{ flexShrink: 1, minWidth: 0 }}
      >
        {resolveLabel()}
      </Text>
    </Button>
  );
}
