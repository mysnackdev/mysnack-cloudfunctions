export type PaymentMethodRecord = {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  description?: string;
};

export const DEFAULT_PAYMENT_METHODS: PaymentMethodRecord[] = [
  {
    id: "credit",
    name: "Cartão de Crédito",
    type: "credit",
    enabled: true,
    description: "Aceite pagamentos com cartão de crédito de todas as bandeiras"
  },
  {
    id: "debit",
    name: "Cartão de Débito",
    type: "debit",
    enabled: true,
    description: "Aceite pagamentos com cartão de débito"
  },
  {
    id: "pix",
    name: "PIX",
    type: "pix",
    enabled: true,
    description: "Receba pagamentos instantâneos via PIX"
  },
  {
    id: "cash",
    name: "Dinheiro",
    type: "cash",
    enabled: true,
    description: "Aceite pagamentos em dinheiro na entrega"
  },
  {
    id: "wallet",
    name: "Carteira Digital",
    type: "wallet",
    enabled: false,
    description: "Pagamentos via carteiras digitais (Apple Pay, Google Pay, etc.)"
  }
];

export function sanitizePaymentMethods(raw: any): PaymentMethodRecord[] {
  const parsed = Array.isArray(raw) ? raw : [];
  const defaults = new Map<string, PaymentMethodRecord>(
    DEFAULT_PAYMENT_METHODS.map((method) => [method.id, { ...method }])
  );
  parsed.forEach((item) => {
    if (!item) return;
    const id = String(item.id || "").trim();
    if (!id) return;
    const base: PaymentMethodRecord =
      defaults.get(id) || {
        id,
        name: String(item.name || id),
        type: String(item.type || "other"),
        enabled: false
      };
    defaults.set(id, {
      ...base,
      enabled: Boolean(item.enabled),
      name: String(item.name || base.name),
      type: String(item.type || base.type),
      description: item.description ? String(item.description) : base.description
    });
  });
  return Array.from(defaults.values());
}

