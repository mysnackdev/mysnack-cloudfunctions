import { z } from "zod";

const MAX_TABLES_PER_STORE = 2000;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export const storeIdParam = z.object({ storeId: z.string().min(1) });
export const productIdParam = z.object({ productId: z.string().min(1) });
export const categoryParam = z.object({ category: z.string().min(1) });
export const searchQueryParam = z.object({ query: z.string().min(1) });
export const limitParam = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });

export const createOrderSchema = z.object({
  storeId: z.string().min(1),
  tableNumber: z.coerce.number().int().min(1),
  chairId: z.string().optional(),
  items: z.array(z.object({
    itemId: z.string().min(1),
    productId: z.string().min(1).optional(),
    name: z.string().min(1),
    description: z.string().trim().max(2000).optional(),
    price: z.number().min(0),
    qty: z.number().int().min(1),
    image: z.union([z.string().trim().min(1).max(2048), z.literal(null)]).optional(),
    notes: z.string().trim().max(500).optional(),
    modifiers: z.array(z.any()).optional()
  })).min(1),
  paymentMethod: z.string().min(1),
  notes: z.string().optional(),
  sessionId: z.string().optional(),
  customerName: z.string().optional()
});

export const updateOrderStatusSchema = z.object({
  orderId: z.string().min(1),
  status: z.enum(['accepted','preparing','ready','on-the-way','delivered','cancelled']),
  cancelReason: z.string().optional(),
  estimatedTime: z.coerce.number().int().min(0).max(360).optional()
});

export const chairCreateSchema = z.object({
  storeId: z.string().min(1),
  tableNumber: z.coerce.number().int().min(1),
  active: z.boolean().default(true),
  location: z.string().optional()
});

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const dayScheduleSchema = z.object({
  day: z.string().min(1),
  isOpen: z.boolean(),
  openTime: z.string().regex(timePattern).optional(),
  closeTime: z.string().regex(timePattern).optional(),
  breakStart: z.string().regex(timePattern).optional().nullable(),
  breakEnd: z.string().regex(timePattern).optional().nullable()
}).refine((value) => {
  if (!value.isOpen) return true;
  return Boolean(value.openTime) && Boolean(value.closeTime);
}, { message: "Horários de abertura e fechamento são obrigatórios quando o dia está ativo." });

export const openingHoursUpdateSchema = z.object({
  storeId: z.string().min(1),
  hours: z.array(dayScheduleSchema).max(14)
});

export const paymentMethodSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['credit','debit','pix','cash','wallet','other']).default('other'),
  enabled: z.boolean(),
  description: z.string().optional()
});

export const paymentMethodsUpdateSchema = z.object({
  storeId: z.string().min(1),
  methods: z.array(paymentMethodSchema)
});

export const togglePaymentMethodSchema = z.object({
  storeId: z.string().min(1),
  methodId: z.string().min(1),
  enabled: z.boolean()
});

export const mallPaymentMethodsUpdateSchema = z.object({
  mallId: z.string().min(1),
  methods: z.array(paymentMethodSchema)
});

export const mallTogglePaymentMethodSchema = z.object({
  mallId: z.string().min(1),
  methodId: z.string().min(1),
  enabled: z.boolean()
});

export const tableRangeSchema = z.object({
  start: z.coerce.number().int().min(1),
  end: z.coerce.number().int().min(1)
}).refine((range) => range.end >= range.start, { message: "Mesa final deve ser maior ou igual à mesa inicial." })
.refine((range) => (range.end - range.start + 1) <= MAX_TABLES_PER_STORE, {
  message: `Intervalo máximo permitido é de ${MAX_TABLES_PER_STORE} mesas.`,
});

export const deliveryConfigUpdateSchema = z.object({
  storeId: z.string().min(1),
  tableServiceEnabled: z.boolean().default(true),
  manualOrderBypassEnabled: z.boolean().default(true),
  externalDeliveryEnabled: z.boolean().default(false),
  estimatedTime: z.coerce.number().int().min(0).max(360).optional(),
  tableRanges: z.array(tableRangeSchema).max(50).optional()
});

export const storeInfoUpdateSchema = z.object({
  storeId: z.string().min(1).optional(),
  storeName: z.string().trim().min(1).optional(),
  storeDescription: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
});

export const mallIdParam = z.object({ mallId: z.string().min(1) });

const optionalUrlSchema = z.union([
  z.string().trim().url().max(2048),
  z.literal(null)
]).optional();

export const mallUpsertSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  city: z.string().min(1),
  state: z.string().min(2).max(2),
  zipCode: z.string().min(5),
  description: z.string().optional().nullable(),
  logoUrl: optionalUrlSchema,
  bannerUrl: optionalUrlSchema
});

export const mallCreateSchema = mallUpsertSchema;

export const mallUpdateSchema = mallUpsertSchema.partial().extend({
  mallId: z.string().min(1)
});

export const mallToggleSchema = z.object({
  mallId: z.string().min(1),
  isActive: z.boolean()
});

export const storeConfigUpdateSchema = z.object({
  storeId: z.string().min(1).optional(),
  logoUrl: z.union([
    z.string().trim().max(2048),
    z.literal(""),
    z.literal(null)
  ]).optional(),
  autoAcceptOrders: z.boolean().optional()
});
