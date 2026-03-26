export type SignerPalette = {
  color: string;
  tint: string;
};

export function getSignerPalette(index: number): SignerPalette {
  if (index === 0) {
    return {
      color: "var(--signer-1)",
      tint: "var(--signer-1-tint)",
    };
  }

  if (index === 1) {
    return {
      color: "var(--signer-2)",
      tint: "var(--signer-2-tint)",
    };
  }

  if (index === 2) {
    return {
      color: "var(--signer-3)",
      tint: "var(--signer-3-tint)",
    };
  }

  return {
    color: "var(--signer-4)",
    tint: "var(--signer-4-tint)",
  };
}
