/* eslint-env node */
import prisma from "../db.server";
import { shopifyApi } from "@shopify/shopify-api";

const SHOP = "distaxstaging.myshopify.com";
const API_VERSION = "2025-10";

const DISCOUNT_QUERY = `
  query DiscountNodeByCode($query: String!) {
    discountNodes(first: 1, query: $query) {
      edges {
        node {
          id
          discount {
            __typename

            ... on DiscountCodeBasic {
              title
              status
              startsAt
              endsAt
              usageLimit
              asyncUsageCount
              appliesOncePerCustomer
              context {
                ...DiscountContext
              }
              minimumRequirement {
                ...DiscountMinimumRequirement
              }
              customerGets {
                appliesOnOneTimePurchase
                appliesOnSubscription
                value {
                  ...DiscountValue
                }
                items {
                  ...DiscountItems
                }
              }
            }

            ... on DiscountCodeFreeShipping {
              title
              status
              startsAt
              endsAt
              usageLimit
              asyncUsageCount
              appliesOncePerCustomer
              context {
                ...DiscountContext
              }
              maximumShippingPrice {
                amount
                currencyCode
              }
              minimumRequirement {
                ...DiscountMinimumRequirement
              }
              destinationSelection {
                __typename
                ... on DiscountCountries {
                  countries
                  includeRestOfWorld
                }
              }
            }

            ... on DiscountCodeBxgy {
              title
              status
              startsAt
              endsAt
              usageLimit
              asyncUsageCount
              appliesOncePerCustomer
              context {
                ...DiscountContext
              }
              usesPerOrderLimit
              customerBuys {
                items {
                  ...DiscountItems
                }
                value {
                  __typename
                  ... on DiscountQuantity {
                    quantity
                  }
                  ... on DiscountPurchaseAmount {
                    amount
                  }
                }
              }
              customerGets {
                value {
                  ...DiscountValue
                }
                items {
                  ...DiscountItems
                }
              }
            }
          }
        }
      }
    }
  }

  fragment DiscountContext on DiscountContext {
    __typename
    ... on DiscountCustomers {
      customers {
        id
        email
      }
    }
    ... on DiscountCustomerSegments {
      segments {
        id
        name
      }
    }
  }

  fragment DiscountMinimumRequirement on DiscountMinimumRequirement {
    __typename
    ... on DiscountMinimumSubtotal {
      greaterThanOrEqualToSubtotal {
        amount
        currencyCode
      }
    }
    ... on DiscountMinimumQuantity {
      greaterThanOrEqualToQuantity
    }
  }

  fragment DiscountValue on DiscountCustomerGetsValue {
    __typename
    ... on DiscountPercentage {
      percentage
    }
    ... on DiscountAmount {
      amount {
        amount
        currencyCode
      }
      appliesOnEachItem
    }
    ... on DiscountOnQuantity {
      quantity {
        quantity
      }
      effect {
        __typename
        ... on DiscountPercentage {
          percentage
        }
      }
    }
  }

  fragment DiscountItems on DiscountItems {
    __typename
    ... on AllDiscountItems {
      allItems
    }
    ... on DiscountProducts {
      products(first: 250) {
        nodes {
          id
        }
      }
    }
    ... on DiscountCollections {
      collections(first: 250) {
        nodes {
          id
        }
      }
    }
  }
`;

const CUSTOMER_ORDERS_QUERY = `
  query CustomerDiscountUsage($id: ID!) {
    customer(id: $id) {
      orders(first: 250, reverse: true) {
        nodes {
          discountCodes
        }
      }
    }
  }
`;

export async function loader({ request }) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code")?.trim();

    if (!code) {
      return Response.json({
        success: false,
        eligible: false,
        error: "Missing discount code",
      });
    }

    const cart = parseCartContext(url);
    let session = await prisma.session.findFirst({
      where: {
        shop: SHOP,
        isOnline: false,
      },
    });

    if (!session) {
      return Response.json({
        success: false,
        eligible: false,
        error: "Offline session not found",
      });
    }

    session = await refreshSessionIfNeeded(session);

    console.log("SESSION", {
      shop: session.shop,
      accessToken: session.accessToken ? "EXISTS" : "MISSING",
      expires: session.expires,
      refreshToken: session.refreshToken ? "EXISTS" : "MISSING",
      refreshTokenExpires: session.refreshTokenExpires,
    });

    const shopify = shopifyApi({
      apiKey: process.env.SHOPIFY_API_KEY,
      apiSecretKey: process.env.SHOPIFY_API_SECRET,
      scopes: process.env.SCOPES?.split(","),
      hostName: process.env.SHOPIFY_APP_URL?.replace("https://", ""),
      isEmbeddedApp: true,
      apiVersion: API_VERSION,
    });

    const client = new shopify.clients.Graphql({
      session,
    });

    const response = await client.request(DISCOUNT_QUERY, {
      variables: {
        query: `code:${code}`,
      },
    });

    const discountNode = response.data?.discountNodes?.edges?.[0]?.node;

    if (!discountNode) {
      return Response.json({
        success: false,
        eligible: false,
        error: "Discount not found",
      });
    }

    const discount = discountNode.discount;
    const customerUsage = await getCustomerUsage({
      client,
      code,
      discount,
      customerId: cart.customerId,
    });

    const promotion = normalizePromotion({
      code,
      discountNode,
      discount,
    });

    const eligibility = evaluateEligibility({
      cart,
      customerUsage,
      discount,
    });

    return Response.json({
      success: true,
      eligible: eligibility.eligible,
      reasons: eligibility.reasons,
      checks: eligibility.checks,
      promotion,
      input: cart,
    });
  } catch (error) {
    console.error("[PROMO ENGINE ERROR]", error);

    return Response.json({
      success: false,
      eligible: false,
      error: error.message,
    });
  }
}

async function refreshSessionIfNeeded(session) {
  if (!session.expires) {
    console.log("[SHOPIFY TOKEN REFRESH] Skipped: token does not expire", {
      shop: session.shop,
      isOnline: session.isOnline,
    });

    return session;
  }

  const refreshWindowMs = 5 * 60 * 1000;
  const expiresAt = new Date(session.expires).getTime();
  const shouldRefresh = expiresAt <= Date.now() + refreshWindowMs;

  if (!shouldRefresh) {
    console.log("[SHOPIFY TOKEN REFRESH] Skipped: token still valid", {
      shop: session.shop,
      expires: session.expires,
    });

    return session;
  }

  if (!session.refreshToken) {
    console.log("[SHOPIFY TOKEN REFRESH] Failed: missing refresh token", {
      shop: session.shop,
      expires: session.expires,
    });

    return session;
  }

  try {
    console.log("[SHOPIFY TOKEN REFRESH] Started", {
      shop: session.shop,
      expires: session.expires,
      refreshTokenExpires: session.refreshTokenExpires,
    });

    const tokenResponse = await fetch(
      `https://${session.shop}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: process.env.SHOPIFY_API_KEY,
          client_secret: process.env.SHOPIFY_API_SECRET,
          grant_type: "refresh_token",
          refresh_token: session.refreshToken,
        }),
      },
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.log("[SHOPIFY TOKEN REFRESH] Failed: token endpoint error", {
        shop: session.shop,
        status: tokenResponse.status,
        error: tokenData.error,
        errorDescription: tokenData.error_description,
      });

      return session;
    }

    const now = Date.now();
    const expires = tokenData.expires_in
      ? new Date(now + Number(tokenData.expires_in) * 1000)
      : null;
    const refreshTokenExpires = tokenData.refresh_token_expires_in
      ? new Date(now + Number(tokenData.refresh_token_expires_in) * 1000)
      : session.refreshTokenExpires;

    const updatedSession = await prisma.session.update({
      where: {
        id: session.id,
      },
      data: {
        accessToken: tokenData.access_token,
        expires,
        refreshToken: tokenData.refresh_token || session.refreshToken,
        refreshTokenExpires,
        scope: tokenData.scope || session.scope,
      },
    });

    console.log("[SHOPIFY TOKEN REFRESH] Success", {
      shop: updatedSession.shop,
      expires: updatedSession.expires,
      refreshToken: updatedSession.refreshToken ? "UPDATED" : "MISSING",
      refreshTokenExpires: updatedSession.refreshTokenExpires,
    });

    return updatedSession;
  } catch (error) {
    console.log("[SHOPIFY TOKEN REFRESH] Failed: request exception", {
      shop: session.shop,
      message: error.message,
    });

    return session;
  }
}

function parseCartContext(url) {
  const productIds = parseIdList(url.searchParams.get("productIds"));
  const collectionIds = parseIdList(url.searchParams.get("collectionIds"));
  const customerSegmentIds = parseIdList(url.searchParams.get("customerSegmentIds"));
  const subtotal = parseOptionalNumber(url.searchParams.get("subtotal"));
  const quantity = parseOptionalNumber(url.searchParams.get("quantity"));
  const shippingPrice = parseOptionalNumber(url.searchParams.get("shippingPrice"));
  const countryCode = url.searchParams.get("countryCode")?.trim().toUpperCase() || null;
  const customerId = normalizeGid(
    url.searchParams.get("customerId"),
    "Customer",
  );
  const customerEmail = url.searchParams.get("customerEmail")?.trim().toLowerCase() || null;

  return {
    productIds,
    collectionIds,
    customerSegmentIds,
    subtotal,
    quantity,
    shippingPrice,
    countryCode,
    customerId,
    customerEmail,
  };
}

function parseIdList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.split("/").pop())
    .filter(Boolean);
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeGid(value, type) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed.startsWith("gid://")) {
    return trimmed;
  }

  return `gid://shopify/${type}/${trimmed}`;
}

async function getCustomerUsage({ client, code, discount, customerId }) {
  if (!discount.appliesOncePerCustomer || !customerId) {
    return {
      checked: false,
      used: false,
    };
  }

  const response = await client.request(CUSTOMER_ORDERS_QUERY, {
    variables: {
      id: customerId,
    },
  });

  const normalizedCode = code.toLowerCase();
  const orders = response.data?.customer?.orders?.nodes || [];
  const used = orders.some((order) => {
    return (order.discountCodes || []).some((discountCode) => {
      return discountCode.toLowerCase() === normalizedCode;
    });
  });

  return {
    checked: true,
    used,
  };
}

function normalizePromotion({ code, discountNode, discount }) {
  const customerGets = discount.customerGets;
  const value = customerGets?.value;
  const items = customerGets?.items;

  return {
    id: discountNode.id,
    code,
    discountType: discount.__typename,
    title: discount.title,
    status: discount.status,
    type: normalizeValueType(value),
    value: normalizeValue(value),
    usageLimit: discount.usageLimit,
    usageCount: discount.asyncUsageCount,
    appliesOncePerCustomer: discount.appliesOncePerCustomer,
    appliesToAll: items?.__typename === "AllDiscountItems",
    eligibleProducts: extractNumericIds(items?.products?.nodes),
    eligibleCollections: extractNumericIds(items?.collections?.nodes),
    customerEligibility: normalizeCustomerContext(discount.context),
    minimumRequirement: normalizeMinimumRequirement(discount.minimumRequirement),
    destinationSelection: normalizeDestinationSelection(discount.destinationSelection),
    maximumShippingPrice: normalizeMoney(discount.maximumShippingPrice),
    startsAt: discount.startsAt,
    endsAt: discount.endsAt,
  };
}

function normalizeValueType(value) {
  if (!value) {
    return null;
  }

  if (value.__typename === "DiscountPercentage") {
    return "percentage";
  }

  if (value.__typename === "DiscountAmount") {
    return "fixed_amount";
  }

  if (value.__typename === "DiscountOnQuantity") {
    return "quantity";
  }

  return value.__typename;
}

function normalizeValue(value) {
  if (!value) {
    return null;
  }

  if (value.__typename === "DiscountPercentage") {
    return value.percentage;
  }

  if (value.__typename === "DiscountAmount") {
    return {
      ...normalizeMoney(value.amount),
      appliesOnEachItem: value.appliesOnEachItem,
    };
  }

  if (value.__typename === "DiscountOnQuantity") {
    return {
      quantity: value.quantity?.quantity,
      effect: normalizeValue(value.effect),
    };
  }

  return null;
}

function normalizeCustomerContext(context) {
  if (!context) {
    return null;
  }

  if (
    context.__typename === "DiscountCustomerAll" ||
    context.__typename === "DiscountBuyerSelectionAll"
  ) {
    return {
      type: "all",
    };
  }

  if (context.__typename === "DiscountCustomers") {
    return {
      type: "customers",
      customers: (context.customers || []).map((customer) => ({
        id: customer.id,
        numericId: numericIdFromGid(customer.id),
        email: customer.email,
      })),
    };
  }

  if (context.__typename === "DiscountCustomerSegments") {
    return {
      type: "segments",
      segments: (context.segments || []).map((segment) => ({
        id: segment.id,
        numericId: numericIdFromGid(segment.id),
        name: segment.name,
      })),
    };
  }

  return {
    type: context.__typename,
  };
}

function normalizeMinimumRequirement(requirement) {
  if (!requirement) {
    return null;
  }

  if (requirement.__typename === "DiscountMinimumSubtotal") {
    return {
      type: "subtotal",
      subtotal: normalizeMoney(requirement.greaterThanOrEqualToSubtotal),
    };
  }

  if (requirement.__typename === "DiscountMinimumQuantity") {
    return {
      type: "quantity",
      quantity: Number(requirement.greaterThanOrEqualToQuantity),
    };
  }

  return {
    type: requirement.__typename,
  };
}

function normalizeDestinationSelection(destinationSelection) {
  if (!destinationSelection) {
    return null;
  }

  if (destinationSelection.__typename === "DiscountCountryAll") {
    return {
      type: "all",
    };
  }

  if (destinationSelection.__typename === "DiscountCountries") {
    return {
      type: "countries",
      countries: destinationSelection.countries || [],
      includeRestOfWorld: destinationSelection.includeRestOfWorld,
    };
  }

  return {
    type: destinationSelection.__typename,
  };
}

function normalizeMoney(money) {
  if (!money) {
    return null;
  }

  return {
    amount: Number(money.amount),
    currencyCode: money.currencyCode,
  };
}

function extractNumericIds(nodes = []) {
  return nodes.map((node) => numericIdFromGid(node.id)).filter(Boolean);
}

function numericIdFromGid(id) {
  return id?.split("/").pop() || null;
}

function evaluateEligibility({ cart, customerUsage, discount }) {
  const checks = [];

  checks.push(checkSupportedDiscountType(discount));
  checks.push(checkStatus(discount));
  checks.push(checkDateWindow(discount));
  checks.push(checkUsageLimit(discount));
  checks.push(checkOncePerCustomer(discount, cart, customerUsage));
  checks.push(checkCustomerContext(discount.context, cart));
  checks.push(checkMinimumRequirement(discount.minimumRequirement, cart));
  checks.push(checkDiscountItems(discount.customerGets?.items, cart));
  checks.push(checkDestination(discount.destinationSelection, cart));
  checks.push(checkMaximumShippingPrice(discount, cart));

  const failedChecks = checks.filter((check) => check.passed === false);
  const eligible = failedChecks.length === 0;

  return {
    eligible,
    checks,
    reasons: failedChecks.map((check) => check.reason),
  };
}

function checkSupportedDiscountType(discount) {
  const supportedTypes = [
    "DiscountCodeBasic",
    "DiscountCodeFreeShipping",
    "DiscountCodeBxgy",
  ];

  return {
    name: "supported_discount_type",
    passed: supportedTypes.includes(discount.__typename),
    reason: supportedTypes.includes(discount.__typename)
      ? null
      : `Unsupported discount type: ${discount.__typename}`,
  };
}

function checkStatus(discount) {
  return {
    name: "active_status",
    passed: discount.status === "ACTIVE",
    reason: discount.status === "ACTIVE"
      ? null
      : `Discount is ${String(discount.status).toLowerCase()}`,
  };
}

function checkDateWindow(discount) {
  const now = new Date();
  const startsAt = discount.startsAt ? new Date(discount.startsAt) : null;
  const endsAt = discount.endsAt ? new Date(discount.endsAt) : null;

  if (startsAt && startsAt > now) {
    return {
      name: "starts_at",
      passed: false,
      reason: "Discount has not started yet",
    };
  }

  if (endsAt && endsAt <= now) {
    return {
      name: "ends_at",
      passed: false,
      reason: "Discount is expired",
    };
  }

  return {
    name: "date_window",
    passed: true,
    reason: null,
  };
}

function checkUsageLimit(discount) {
  if (discount.usageLimit === null || discount.usageLimit === undefined) {
    return {
      name: "usage_limit",
      passed: true,
      reason: null,
    };
  }

  const passed = discount.asyncUsageCount < discount.usageLimit;

  return {
    name: "usage_limit",
    passed,
    reason: passed ? null : "Discount usage limit has been reached",
    usageLimit: discount.usageLimit,
    usageCount: discount.asyncUsageCount,
  };
}

function checkOncePerCustomer(discount, cart, customerUsage) {
  if (!discount.appliesOncePerCustomer) {
    return {
      name: "once_per_customer",
      passed: true,
      reason: null,
    };
  }

  if (!cart.customerId) {
    return {
      name: "once_per_customer",
      passed: false,
      reason: "Customer ID is required for once-per-customer discounts",
    };
  }

  return {
    name: "once_per_customer",
    passed: !customerUsage.used,
    reason: customerUsage.used
      ? "Customer has already used this discount"
      : null,
    checkedOrderHistory: customerUsage.checked,
  };
}

function checkCustomerContext(context, cart) {
  if (
    !context ||
    context.__typename === "DiscountCustomerAll" ||
    context.__typename === "DiscountBuyerSelectionAll"
  ) {
    return {
      name: "customer_eligibility",
      passed: true,
      reason: null,
    };
  }

  if (context.__typename === "DiscountCustomers") {
    const customerIds = (context.customers || []).map((customer) => customer.id);
    const customerEmails = (context.customers || [])
      .map((customer) => customer.email?.toLowerCase())
      .filter(Boolean);
    const passed =
      (cart.customerId && customerIds.includes(cart.customerId)) ||
      (cart.customerEmail && customerEmails.includes(cart.customerEmail));

    return {
      name: "customer_eligibility",
      passed,
      reason: passed ? null : "Customer is not eligible for this discount",
    };
  }

  if (context.__typename === "DiscountCustomerSegments") {
    const segmentIds = (context.segments || []).map((segment) => numericIdFromGid(segment.id));
    const passed = cart.customerSegmentIds.some((segmentId) => {
      return segmentIds.includes(segmentId);
    });

    return {
      name: "customer_eligibility",
      passed,
      reason: passed
        ? null
        : "Customer is not in an eligible customer segment",
      requiredSegmentIds: segmentIds,
    };
  }

  return {
    name: "customer_eligibility",
    passed: false,
    reason: `Unsupported customer eligibility context: ${context.__typename}`,
  };
}

function checkMinimumRequirement(requirement, cart) {
  if (!requirement) {
    return {
      name: "minimum_requirement",
      passed: true,
      reason: null,
    };
  }

  if (requirement.__typename === "DiscountMinimumSubtotal") {
    const requiredSubtotal = Number(
      requirement.greaterThanOrEqualToSubtotal?.amount,
    );

    if (cart.subtotal === null) {
      return {
        name: "minimum_subtotal",
        passed: false,
        reason: "Cart subtotal is required for this discount",
        requiredSubtotal,
      };
    }

    return {
      name: "minimum_subtotal",
      passed: cart.subtotal >= requiredSubtotal,
      reason: cart.subtotal >= requiredSubtotal
        ? null
        : `Cart subtotal must be at least ${requiredSubtotal}`,
      requiredSubtotal,
      cartSubtotal: cart.subtotal,
    };
  }

  if (requirement.__typename === "DiscountMinimumQuantity") {
    const requiredQuantity = Number(requirement.greaterThanOrEqualToQuantity);

    if (cart.quantity === null) {
      return {
        name: "minimum_quantity",
        passed: false,
        reason: "Cart quantity is required for this discount",
        requiredQuantity,
      };
    }

    return {
      name: "minimum_quantity",
      passed: cart.quantity >= requiredQuantity,
      reason: cart.quantity >= requiredQuantity
        ? null
        : `Cart quantity must be at least ${requiredQuantity}`,
      requiredQuantity,
      cartQuantity: cart.quantity,
    };
  }

  return {
    name: "minimum_requirement",
    passed: false,
    reason: `Unsupported minimum requirement: ${requirement.__typename}`,
  };
}

function checkDiscountItems(items, cart) {
  if (!items || items.__typename === "AllDiscountItems") {
    return {
      name: "item_eligibility",
      passed: true,
      reason: null,
    };
  }

  if (items.__typename === "DiscountProducts") {
    const requiredProductIds = extractNumericIds(items.products?.nodes);
    const passed = cart.productIds.some((productId) => {
      return requiredProductIds.includes(productId);
    });

    return {
      name: "product_eligibility",
      passed,
      reason: passed
        ? null
        : "Cart does not contain an eligible product",
      requiredProductIds,
    };
  }

  if (items.__typename === "DiscountCollections") {
    const requiredCollectionIds = extractNumericIds(items.collections?.nodes);
    const passed = cart.collectionIds.some((collectionId) => {
      return requiredCollectionIds.includes(collectionId);
    });

    return {
      name: "collection_eligibility",
      passed,
      reason: passed
        ? null
        : "Cart does not contain a product from an eligible collection",
      requiredCollectionIds,
    };
  }

  return {
    name: "item_eligibility",
    passed: false,
    reason: `Unsupported item eligibility: ${items.__typename}`,
  };
}

function checkDestination(destinationSelection, cart) {
  if (!destinationSelection || destinationSelection.__typename === "DiscountCountryAll") {
    return {
      name: "country_eligibility",
      passed: true,
      reason: null,
    };
  }

  if (!cart.countryCode) {
    return {
      name: "country_eligibility",
      passed: false,
      reason: "Country code is required for this discount",
    };
  }

  if (destinationSelection.__typename === "DiscountCountries") {
    const countries = destinationSelection.countries || [];
    const passed =
      countries.includes(cart.countryCode) ||
      destinationSelection.includeRestOfWorld;

    return {
      name: "country_eligibility",
      passed,
      reason: passed
        ? null
        : "Shipping country is not eligible for this discount",
      eligibleCountries: countries,
      includeRestOfWorld: destinationSelection.includeRestOfWorld,
    };
  }

  return {
    name: "country_eligibility",
    passed: false,
    reason: `Unsupported destination selection: ${destinationSelection.__typename}`,
  };
}

function checkMaximumShippingPrice(discount, cart) {
  if (!discount.maximumShippingPrice) {
    return {
      name: "maximum_shipping_price",
      passed: true,
      reason: null,
    };
  }

  const maximumShippingPrice = Number(discount.maximumShippingPrice.amount);

  if (cart.shippingPrice === null) {
    return {
      name: "maximum_shipping_price",
      passed: false,
      reason: "Shipping price is required for this discount",
      maximumShippingPrice,
    };
  }

  return {
    name: "maximum_shipping_price",
    passed: cart.shippingPrice <= maximumShippingPrice,
    reason: cart.shippingPrice <= maximumShippingPrice
      ? null
      : `Shipping price must be at most ${maximumShippingPrice}`,
    maximumShippingPrice,
    shippingPrice: cart.shippingPrice,
  };
}
