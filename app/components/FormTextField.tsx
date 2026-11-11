// 2026-11-11 — Polaris TextField for plain <Form> posts.
//
// Polaris 13 TextField is always controlled: it has no `defaultValue` prop and
// renders value="" when none is given. Used inside an uncontrolled form with
// `defaultValue`, every field rendered EMPTY, could not be typed into, and the
// save posted blanks — wiping saved job details. This wrapper keeps the typed
// value in state (seeded from defaultValue, re-seeded when the loader data
// changes) so the form posts what the user sees.

import { useEffect, useState } from "react";
import { TextField, type TextFieldProps } from "@shopify/polaris";

export type FormTextFieldProps = Omit<TextFieldProps, "value" | "onChange"> & {
  defaultValue?: string | number | null;
  onChange?: (value: string) => void;
};

export function FormTextField({ defaultValue, onChange, ...props }: FormTextFieldProps) {
  const initial = defaultValue == null ? "" : String(defaultValue);
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  return (
    <TextField
      {...(props as TextFieldProps)}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}
