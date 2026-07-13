import { Capacitor, registerPlugin } from '@capacitor/core';

export interface IOSBillingProduct {
  productId: string;
  title: string;
  description: string;
  price: string;
  billingPeriod?: string;
}

export interface IOSBillingPurchase {
  productId: string;
  purchaseToken: string;
  acknowledged: boolean;
  autoRenewing: boolean;
  purchaseTime: number;
}

export interface IOSRestoredPurchase {
  productId: string;
  purchaseToken: string;
}

interface CapacitorWithPlugins {
  Plugins?: Record<string, unknown>;
}

// The native plugin can't call CAPPluginCall.reject(...) under the Xcode toolchain this app
// currently builds with (a packaging bug in the shipped Capacitor interface hides that method
// entirely — see StoreKitBillingPlugin.swift). It resolves with an `__error` marker key instead;
// every method below unwraps that back into a real thrown error, so call sites in App.tsx don't
// need to know about this workaround at all.
interface ErrorMarker {
  __error?: string;
}

interface StoreKitBillingPlugin {
  getProducts(options: { productIds: string[] }): Promise<{ products: IOSBillingProduct[] } & ErrorMarker>;
  purchaseSubscription(options: { productId: string }): Promise<{ success: boolean } & ErrorMarker>;
  getActiveSubscriptions(): Promise<{ purchases: IOSBillingPurchase[] } & ErrorMarker>;
  restorePurchases(): Promise<{ purchases: IOSBillingPurchase[] } & ErrorMarker>;
  addListener(
    eventName: 'purchaseRestored',
    listenerFunc: (data: IOSRestoredPurchase) => void,
  ): Promise<import('@capacitor/core').PluginListenerHandle>;
}

export function isStoreKitBridgeAvailable(): boolean {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios') {
    return false;
  }

  if (typeof Capacitor.isPluginAvailable === 'function') {
    if (Capacitor.isPluginAvailable('StoreKitBilling')) {
      return true;
    }
  }

  // On some builds a JS proxy can exist even when the native plugin is not packaged.
  const nativePlugins = (Capacitor as unknown as CapacitorWithPlugins).Plugins;
  return Boolean(nativePlugins?.StoreKitBilling);
}

const NativeStoreKitBilling = registerPlugin<StoreKitBillingPlugin>('StoreKitBilling');

function unwrap<T extends ErrorMarker>(result: T): Omit<T, '__error'> {
  if (result.__error) {
    throw new Error(result.__error);
  }
  return result;
}

export const StoreKitBilling = {
  async getProducts(options: { productIds: string[] }) {
    return unwrap(await NativeStoreKitBilling.getProducts(options));
  },
  async purchaseSubscription(options: { productId: string }) {
    return unwrap(await NativeStoreKitBilling.purchaseSubscription(options));
  },
  async getActiveSubscriptions() {
    return unwrap(await NativeStoreKitBilling.getActiveSubscriptions());
  },
  async restorePurchases() {
    return unwrap(await NativeStoreKitBilling.restorePurchases());
  },
  addListener: NativeStoreKitBilling.addListener.bind(NativeStoreKitBilling),
};
