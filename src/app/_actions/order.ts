"use server"

import { cookies } from "next/headers"
import { db } from "@/db"
import { carts, products } from "@/db/schema"
import type { CartLineItem, CheckoutItem } from "@/types"
import { desc, eq, inArray } from "drizzle-orm"
import { type z } from "zod"

import { stripe } from "@/lib/stripe"
import type { getOrderLineItemsSchema } from "@/lib/validations/order"

export async function getOrderLineItems(
  input: z.infer<typeof getOrderLineItemsSchema>
): Promise<CartLineItem[]> {
  try {
    const checkoutItems: CheckoutItem[] = []

    const parsedItems: unknown = JSON.parse(input.items ?? "[]")
    if (Array.isArray(parsedItems)) {
      checkoutItems.forEach((item) => {
        if (typeof item === "object") {
          checkoutItems.push(item)
        }
      })
    }

    if (checkoutItems.length === 0) return []

    const lineItems = await db
      .select({
        id: products.id,
        name: products.name,
        images: products.images,
        category: products.category,
        subcategory: products.subcategory,
        price: products.price,
        inventory: products.inventory,
        storeId: products.storeId,
      })
      .from(products)
      .where(
        inArray(
          products.id,
          checkoutItems.map((item) => item.productId)
        )
      )
      .groupBy(products.id)
      .orderBy(desc(products.createdAt))
      .then((items) => {
        return items.map((item) => {
          const quantity = checkoutItems.find(
            (checkoutItem) => checkoutItem.productId === item.id
          )?.quantity

          return {
            ...item,
            quantity: quantity ?? 0,
          }
        })
      })

    return lineItems
  } catch (err) {
    console.error(err)
    return []
  }
}

export async function getCheckoutSessionLineItems(
  input: z.infer<typeof getOrderLineItemsSchema>
) {
  try {
    if (!input.storeId) {
      throw new Error("Store ID is required.")
    }

    const cartId = Number(cookies().get("cartId")?.value)

    const cart = await db.query.carts.findFirst({
      columns: {
        checkoutSessionId: true,
      },
      where: eq(carts.id, cartId),
    })

    if (!cart || !cart.checkoutSessionId) {
      throw new Error("Cart not found.")
    }

    // Clear the cart
    await db
      .update(carts)
      .set({ closed: true, items: [] })
      .where(eq(carts.id, cartId))

    // Retrieve the checkout session
    // checkout session is not found for some reason
    const checkoutSession = await stripe.checkout.sessions.retrieve(
      cart.checkoutSessionId
    )

    // Get checkout items from the checkout session metadata
    const checkoutItems: CheckoutItem[] = []

    const parsedItems: unknown = JSON.parse(
      checkoutSession?.metadata?.items ?? ""
    )
    if (Array.isArray(parsedItems)) {
      checkoutItems.forEach((item) => {
        if (typeof item === "object") {
          checkoutItems.push(item)
        }
      })
    }

    // TODO: Create order on webhook instead
    // await db.insert(orders).values({
    //   storeId: input.storeId,
    //   items: checkoutItems,
    //   stripePaymentIntentId: String(checkoutSession.payment_intent),
    //   stripePaymentIntentStatus: checkoutSession.payment_status,
    // })

    // Get products from the checkout items
    const lineItems = await db
      .select({
        id: products.id,
        name: products.name,
        price: products.price,
        images: products.images,
        storeId: products.storeId,
      })
      .from(products)
      .where(
        inArray(
          products.id,
          checkoutItems.map((item) => item.productId)
        )
      )
      .orderBy(desc(products.createdAt))
      .then((items) => {
        return items.map((item) => {
          const quantity = checkoutItems.find(
            (checkoutItem) => checkoutItem.productId === item.id
          )?.quantity

          return {
            ...item,
            quantity: quantity ?? 0,
          }
        })
      })

    return lineItems
  } catch (err) {
    err instanceof Error && console.error(err.message)
    return []
  }
}