package com.mojfit.app;

import android.app.Activity;
import androidx.annotation.NonNull;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesResponseListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONException;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@CapacitorPlugin(name = "PlayBilling")
public class PlayBillingPlugin extends Plugin {
  private BillingClient billingClient;
  private final Map<String, ProductDetails> productDetailsById = new HashMap<>();
  private PluginCall purchaseCall;

  @Override
  public void load() {
    super.load();
    try {
      initializeBillingClientIfNeeded();
      connectBillingAndQueryPurchases();
    } catch (Exception ex) {
      Logger.error("PlayBilling failed to initialize during plugin load", ex);
      billingClient = null;
    }
  }

  private void initializeBillingClientIfNeeded() {
    if (billingClient != null) return;

    billingClient = BillingClient.newBuilder(getContext())
      .setListener((billingResult, purchases) -> {
        if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK || purchases == null || purchases.isEmpty()) {
          if (purchaseCall != null) {
            purchaseCall.reject("Purchase failed: " + billingResult.getDebugMessage());
            purchaseCall = null;
          }
          return;
        }

        for (Purchase purchase : purchases) {
          if (purchase.getPurchaseState() != Purchase.PurchaseState.PURCHASED) continue;
          acknowledgeIfNeeded(purchase);

          if (purchaseCall != null) {
            JSObject result = new JSObject();
            result.put("success", true);
            purchaseCall.resolve(result);
            purchaseCall = null;
            return;
          }

          // purchaseCall is null — app was restarted during payment; notify JS
          notifyRestoredPurchase(purchase);
        }

        if (purchaseCall != null) {
          purchaseCall.reject("Purchase failed: no completed purchase found");
          purchaseCall = null;
        }
      })
      .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
      .build();
  }

  private void connectBillingAndQueryPurchases() {
    if (billingClient == null) return;
    ensureBillingReady(() -> {
      QueryPurchasesParams params = QueryPurchasesParams.newBuilder()
        .setProductType(BillingClient.ProductType.SUBS)
        .build();
      billingClient.queryPurchasesAsync(params, (result, purchasesList) -> {
        if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) return;
        for (Purchase purchase : purchasesList) {
          if (purchase.getPurchaseState() != Purchase.PurchaseState.PURCHASED) continue;
          acknowledgeIfNeeded(purchase);
          notifyRestoredPurchase(purchase);
        }
      });
    }, null);
  }

  private void notifyRestoredPurchase(Purchase purchase) {
    List<String> productIds = purchase.getProducts();
    if (productIds == null || productIds.isEmpty()) return;
    JSObject data = new JSObject();
    data.put("productId", productIds.get(0));
    data.put("purchaseToken", purchase.getPurchaseToken());
    notifyListeners("purchaseRestored", data);
  }

  /**
   * Ensures the billing client is connected, then runs onReady.
   * If already connected, onReady runs immediately.
   * If not connected, starts connection and runs onReady once setup finishes.
   * On failure, rejects onError if provided.
   */
  private void ensureBillingReady(Runnable onReady, PluginCall onError) {
    if (billingClient == null) {
      try {
        initializeBillingClientIfNeeded();
      } catch (Exception ex) {
        if (onError != null) {
          onError.reject("Billing client initialization failed: " + ex.getMessage());
        }
        Logger.error("PlayBilling failed to initialize on demand", ex);
        return;
      }
    }
    if (billingClient.isReady()) {
      onReady.run();
      return;
    }
    billingClient.startConnection(new BillingClientStateListener() {
      @Override
      public void onBillingSetupFinished(@NonNull BillingResult billingResult) {
        if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK) {
          onReady.run();
        } else if (onError != null) {
          onError.reject("Billing setup failed: " + billingResult.getDebugMessage());
        }
      }

      @Override
      public void onBillingServiceDisconnected() {
        // Will reconnect on next ensureBillingReady call.
      }
    });
  }

  @PluginMethod
  public void getProducts(PluginCall call) {
    JSArray ids = call.getArray("productIds", new JSArray());
    if (ids.length() == 0) {
      call.reject("productIds are required");
      return;
    }

    List<QueryProductDetailsParams.Product> products = new ArrayList<>();
    for (int i = 0; i < ids.length(); i++) {
      String productId;
      try {
        productId = ids.getString(i);
      } catch (JSONException ignored) {
        continue;
      }
      if (productId == null || productId.isEmpty()) continue;
      products.add(
        QueryProductDetailsParams.Product.newBuilder()
          .setProductId(productId)
          .setProductType(BillingClient.ProductType.SUBS)
          .build()
      );
    }

    QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder()
      .setProductList(products)
      .build();

    ensureBillingReady(() -> billingClient.queryProductDetailsAsync(params, (billingResult, queryResult) -> {
      if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK) {
        call.reject("Product query failed: " + billingResult.getDebugMessage());
        return;
      }

      JSArray out = new JSArray();
      productDetailsById.clear();
      List<ProductDetails> productDetailsList = queryResult.getProductDetailsList();
      if (productDetailsList == null) {
        productDetailsList = new ArrayList<>();
      }

      for (ProductDetails pd : productDetailsList) {
        productDetailsById.put(pd.getProductId(), pd);

        List<ProductDetails.SubscriptionOfferDetails> offers = pd.getSubscriptionOfferDetails();
        if (offers == null || offers.isEmpty()) {
          JSObject item = new JSObject();
          item.put("productId", pd.getProductId());
          item.put("title", pd.getTitle());
          item.put("description", pd.getDescription());
          item.put("price", "");
          out.put(item);
          continue;
        }

        for (ProductDetails.SubscriptionOfferDetails offer : offers) {
          JSObject item = new JSObject();
          item.put("productId", pd.getProductId());
          item.put("title", pd.getTitle());
          item.put("description", pd.getDescription());

          String offerToken = offer.getOfferToken();
          if (offerToken != null) item.put("offerToken", offerToken);
          if (offer.getBasePlanId() != null) item.put("basePlanId", offer.getBasePlanId());
          if (offer.getOfferId() != null) item.put("offerId", offer.getOfferId());

          String price = "";
          String billingPeriod = null;
          List<ProductDetails.PricingPhase> phases = offer.getPricingPhases().getPricingPhaseList();
          if (phases != null && !phases.isEmpty()) {
            ProductDetails.PricingPhase selectedPhase = phases.get(phases.size() - 1);
            price = selectedPhase.getFormattedPrice();
            billingPeriod = selectedPhase.getBillingPeriod();
          }

          item.put("price", price);
          if (billingPeriod != null) item.put("billingPeriod", billingPeriod);
          out.put(item);
        }
      }

      JSObject result = new JSObject();
      result.put("products", out);
      call.resolve(result);
    }), call);
  }

  @PluginMethod
  public void purchaseSubscription(PluginCall call) {
    String productId = call.getString("productId", "");
    String offerToken = call.getString("offerToken");
    if (productId.isEmpty()) {
      call.reject("productId is required");
      return;
    }

    ensureBillingReady(() -> {
      ProductDetails pd = productDetailsById.get(productId);
      if (pd == null) {
        call.reject("Missing product details for " + productId + ". Call getProducts first.");
        return;
      }

      String token = offerToken;
      if (token == null || token.isEmpty()) {
        List<ProductDetails.SubscriptionOfferDetails> offers = pd.getSubscriptionOfferDetails();
        if (offers != null && !offers.isEmpty()) {
          token = offers.get(0).getOfferToken();
        }
      }

      if (token == null || token.isEmpty()) {
        call.reject("No offer token for product " + productId);
        return;
      }

      BillingFlowParams.ProductDetailsParams detailsParams = BillingFlowParams.ProductDetailsParams.newBuilder()
        .setProductDetails(pd)
        .setOfferToken(token)
        .build();

      BillingFlowParams flowParams = BillingFlowParams.newBuilder()
        .setProductDetailsParamsList(java.util.Collections.singletonList(detailsParams))
        .build();

      Activity activity = getActivity();
      if (activity == null) {
        call.reject("No activity available");
        return;
      }

      purchaseCall = call;
      BillingResult launchResult = billingClient.launchBillingFlow(activity, flowParams);
      if (launchResult.getResponseCode() != BillingClient.BillingResponseCode.OK) {
        purchaseCall = null;
        call.reject("Unable to launch billing flow: " + launchResult.getDebugMessage());
      }
    }, call);
  }

  @PluginMethod
  public void getActiveSubscriptions(PluginCall call) {
    QueryPurchasesParams params = QueryPurchasesParams.newBuilder()
      .setProductType(BillingClient.ProductType.SUBS)
      .build();

    ensureBillingReady(() -> billingClient.queryPurchasesAsync(params, (billingResult, purchasesList) -> {
      if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK) {
        call.reject("Query purchases failed: " + billingResult.getDebugMessage());
        return;
      }

      JSArray purchases = new JSArray();
      for (Purchase purchase : purchasesList) {
        if (purchase.getPurchaseState() != Purchase.PurchaseState.PURCHASED) continue;
        acknowledgeIfNeeded(purchase);

        List<String> productIds = purchase.getProducts();
        if (productIds == null || productIds.isEmpty()) continue;

        JSObject p = new JSObject();
        p.put("productId", productIds.get(0));
        p.put("purchaseToken", purchase.getPurchaseToken());
        p.put("acknowledged", purchase.isAcknowledged());
        p.put("autoRenewing", purchase.isAutoRenewing());
        p.put("purchaseTime", purchase.getPurchaseTime());
        purchases.put(p);
      }

      JSObject result = new JSObject();
      result.put("purchases", purchases);
      call.resolve(result);
    }), call);
  }

  private void acknowledgeIfNeeded(Purchase purchase) {
    if (purchase.isAcknowledged()) return;
    if (billingClient == null || !billingClient.isReady()) return;

    AcknowledgePurchaseParams params = AcknowledgePurchaseParams.newBuilder()
      .setPurchaseToken(purchase.getPurchaseToken())
      .build();

    billingClient.acknowledgePurchase(params, result -> {
      // No-op: purchase query will handle retries if needed.
    });
  }
}
