import { Image, Text, View } from "nsh";
import { Button } from "nsh/base";
import { BUTTON_ACTIVE_STYLE, BUTTON_MOTION_STYLE } from "./motion.ts";

/** Renders custom companion avatar image when configured, falling back to an initial circle. */
export function CompanionAvatar(props: {
  readonly avatarSrc: () => string | undefined;
  readonly initial: () => string;
  readonly size: number;
  readonly class?: string;
  readonly textClass?: string;
}) {
  const src = () => props.avatarSrc()?.trim() || "";
  const radius = () => Math.round(props.size / 2);

  return (
    <If
      when={src().length > 0}
      else={
        <View
          class={props.class ?? "bg-primary"}
          style={{
            width: props.size,
            height: props.size,
            borderRadius: radius(),
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Text class={props.textClass ?? "text-xs font-bold text-primary-foreground"}>
            {props.initial()}
          </Text>
        </View>
      }
    >
      <View
        class={props.class ?? "bg-card border border-border"}
        style={{
          width: props.size,
          height: props.size,
          borderRadius: radius(),
          overflow: "hidden",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Image
          src={src()}
          style={{
            width: props.size,
            height: props.size,
            borderRadius: radius(),
            objectFit: "cover",
          }}
        />
      </View>
    </If>
  );
}

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
