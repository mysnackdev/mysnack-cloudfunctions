export type CategoryId = 'lanches'|'japonesa'|'pizza'|'doces'|'salgados'|'saudavel'|'bebidas'|'sobremesas'|'vegetariano'|'vegano'|'fit'|'acai';
export type OrderStatus = 'pending'|'accepted'|'preparing'|'ready'|'on-the-way'|'delivered'|'cancelled';

export interface Store {
  id?: string;
  shoppingId?: string;
  name: string;
  ownerId?: string;
  status: 'pending'|'approved'|'active'|'inactive';
  email?: string;
  phone?: string;
  logoUrl?: string;
  bannerUrl?: string;
  category: CategoryId | string;
  rating?: number;
  deliveryTime?: number;
  config?: {
    ordersEnabled?: boolean;
    soundEnabled?: boolean;
    autoAcceptOrders?: boolean;
  };
  openingHours?: any;
  paymentMethods?: any;
  deliveryConfig?: {
    deliveryType: 'table-only'|'both';
    tableDeliveryEnabled: boolean;
    externalDeliveryEnabled: boolean;
  };
  createdAt?: any;
}

export interface Product {
  id?: string;
  storeId: string;
  name: string;
  description?: string;
  price: number;
  imageUrl?: string;
  category: CategoryId | string;
  available: boolean;
  preparationTime?: number;
  deliveryTime?: number;
  createdAt?: any;
}

export interface Chair {
  id?: string;
  storeId: string;
  tableNumber: number;
  qrCodeData: string;
  qrCodeUrl?: string;
  active: boolean;
  location?: string;
  createdAt?: any;
}

export interface Order {
  id?: string;
  storeId: string;
  orderNumber: string;
  status: OrderStatus;
  tableNumber: number;
  chairId?: string;
  items: Array<{ itemId: string; name: string; price: number; qty: number; modifiers?: any[] }>;
  subtotal: number;
  fee: number;
  total: number;
  paymentMethod: string;
  estimatedTime?: number;
  customerId?: string;
  customerName?: string;
  notes?: string;
  createdAt: any;
  updatedAt?: any;
  acceptedAt?: any;
  preparingAt?: any;
  readyAt?: any;
  deliveredAt?: any;
  cancelledAt?: any;
  cancelReason?: string;
}
