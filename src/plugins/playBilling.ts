import { Capacitor, registerPlugin } from '@capacitor/core';

export interface BillingProduct {
  productId: string;
  title: string;
  description: string;
  price: string;
  offerToken?: string;
  basePlanId?: string;
  offerId?: string;
  billingPeriod?: string;
}

export interface BillingPurchase {
  productId: string;
  purchaseToken: string;
  acknowledged: boolean;
  autoRenewing: boolean;
  purchaseTime: number;
  expiresAt?: number;
}

export interface RestoredPurchase {
  productId: string;
  purchaseToken: string;
}

interface CapacitorWithPlugins {
  Plugins?: Record<string, unknown>;
}

interface PlayBillingPlugin {
  getProducts(options: { productIds: string[] }): Promise<{ products: BillingProduct[] }>;
  purchaseSubscription(options: { productId: string; offerToken?: string }): Promise<{ success: boolean }>;
  getActiveSubscriptions(): Promise<{ purchases: BillingPurchase[] }>;
  addListener(
    eventName: 'purchaseRestored',
    listenerFunc: (data: RestoredPurchase) => void,
  ): Promise<import('@capacitor/core').PluginListenerHandle>;
}

export function isPlayBillingBridgeAvailable(): boolean {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    return false;
  }

  if (typeof Capacitor.isPluginAvailable === 'function') {
    if (Capacitor.isPluginAvailable('PlayBilling')) {
      return true;
    }
  }

  // On some builds a JS proxy can exist even when the native plugin is not packaged.
  const nativePlugins = (Capacitor as unknown as CapacitorWithPlugins).Plugins;
  return Boolean(nativePlugins?.PlayBilling);
}

export const PlayBilling = registerPlugin<PlayBillingPlugin>('PlayBilling');
