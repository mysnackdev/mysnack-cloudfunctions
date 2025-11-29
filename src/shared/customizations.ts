export interface CustomizationOption {
  id: string;
  name: string;
  price: number;
}

export interface CustomizationGroup {
  id: string;
  name: string;
  type: "single" | "multiple";
  required: boolean;
  options: CustomizationOption[];
}

const toPrice = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = Number(value.replace(",", "."));
    if (Number.isFinite(normalized)) return normalized;
  }
  return 0;
};

const toBoolean = (value: unknown): boolean => value === true;

const resolveGroupId = (candidateId: unknown, name: string): string => {
  if (typeof candidateId === "string" && candidateId.trim()) return candidateId.trim();
  return name.toLowerCase().replace(/\s+/g, "-");
};

const resolveOptionId = (candidateId: unknown, groupName: string, optionName: string): string => {
  if (typeof candidateId === "string" && candidateId.trim()) return candidateId.trim();
  return `${groupName}-${optionName}`.toLowerCase().replace(/\s+/g, "-");
};

/**
 * Normaliza o payload de customizações recebido do Backoffice antes de persistir.
 */
export const sanitizeCustomizationGroups = (raw: unknown): CustomizationGroup[] => {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((group) => {
      if (!group || typeof group !== "object") return null;
      const name = typeof group.name === "string" ? group.name.trim() : "";
      if (!name) return null;

      const groupRecord = group as Record<string, unknown>;
      const optionsSource: unknown[] = Array.isArray(groupRecord["options"]) ? (groupRecord["options"] as unknown[]) : [];
      const options = optionsSource
        .map((optionEntry): CustomizationOption | null => {
          if (!optionEntry || typeof optionEntry !== "object") return null;
          const option = optionEntry as Record<string, unknown>;
          const rawName = option["name"];
          const optionName = typeof rawName === "string" ? rawName.trim() : "";
          if (!optionName) return null;
          const rawId = option["id"];
          const rawPrice = option["price"];

          return {
            id: resolveOptionId(rawId, name, optionName),
            name: optionName,
            price: toPrice(rawPrice),
          };
        })
        .filter((option): option is CustomizationOption => Boolean(option));

      if (options.length === 0) return null;

      return {
        id: resolveGroupId(groupRecord["id"], name),
        name,
        type: groupRecord["type"] === "multiple" ? "multiple" : "single",
        required: toBoolean(groupRecord["required"]),
        options,
      } satisfies CustomizationGroup;
    })
    .filter((group): group is CustomizationGroup => Boolean(group));
};

/**
 * Ajusta as customizações armazenadas antes de retornar para os clientes.
 * Retorna undefined quando não há grupos ou opções válidas.
 */
export const normalizeCustomizationGroups = (raw: unknown): CustomizationGroup[] | undefined => {
  const sanitized = sanitizeCustomizationGroups(raw);
  return sanitized.length ? sanitized : undefined;
};
