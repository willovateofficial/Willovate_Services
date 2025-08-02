import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import {
  authenticateBusinessOwnerJWT,
  BusinessOwnerRequest,
  authenticateCustomerJWT,
  CustomerRequest,
  CustomerPayload, // ✅ ADD THIS
} from "../middleware/authenticateJWT";
import jwt from "jsonwebtoken";
import { startOfDay, endOfDay, isValid, parse } from "date-fns";

const prisma = new PrismaClient();
const router = Router();

// ✅ POST: Create a new order (no auth)
router.post("/", async (req: Request, res: Response): Promise<void> => {
  try {
    // 👇 Try to extract customer token (without forcing auth)
    let customerId: number | undefined = undefined;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];
      const secret = process.env.JWT_SECRET || "your-secret-key";
      try {
        const decoded = jwt.verify(token, secret) as {
          id: number;
          email: string;
          businessId: number;
        };
        customerId = decoded.id;
      } catch (err) {
        console.warn("🟡 JWT verification failed — continuing as guest");
      }
    }
    const {
      businessId,
      table_number,
      cart_items,
      total_amount,
      payment_method,
      estimated_time,
      pointsUsed, // 👈 add this
    } = req.body;
    console.log("Incoming Order Data:", req.body);
    console.log("Creating order with cart_items:", cart_items);

    if (!businessId) {
      res.status(400).json({ message: "Missing business ID" });
      return;
    }

    if (
      !businessId ||
      !table_number ||
      !cart_items ||
      !total_amount ||
      !payment_method ||
      !estimated_time
    ) {
      res.status(400).json({ message: "Missing required fields" });
      return;
    }

    if (!Array.isArray(cart_items) || cart_items.length === 0) {
      res.status(400).json({ message: "Cart items must be a non-empty array" });
      return;
    }

    const order = await prisma.order.create({
      data: {
        tableNumber: Number(table_number),
        totalAmount: Number(total_amount),
        paymentMethod: payment_method,
        estimatedTime: estimated_time,
        status: "Pending",
        businessId: Number(businessId),
        customerId,
        items: {
          create: cart_items.map((item: any) => ({
            productId: item.productId, // ✅ matches incoming data
            quantity: item.quantity,
            price: item.price,
            name: item.name,
            status: "Pending", // ✅ Set default status for items
          })),
        },
      },
      include: { items: true },
    });

    if (customerId && pointsUsed && pointsUsed > 0) {
      const customer = await prisma.customer.findUnique({
        where: { id: customerId },
      });

      if (customer && (customer.points ?? 0) >= pointsUsed) {
        await prisma.customer.update({
          where: { id: customerId },
          data: {
            points: {
              decrement: pointsUsed,
            },
          },
        });
      } else {
        console.warn("❌ Not enough points or customer not found.");
      }
    }

    if (customerId) {
      const earnedPoints = Math.floor(Number(total_amount) / 100);

      await prisma.customer.update({
        where: { id: customerId },
        data: {
          totalOrders: { increment: 1 },
          totalMoneySpent: { increment: Number(total_amount) },
          points: { increment: earnedPoints },
        },
      });
    }
    // ✅ After order is created, update inventory stock
    for (const item of cart_items) {
      const dish = await prisma.product.findUnique({
        where: { id: item.productId },
      });

      let ingredients: any[] = [];
      if (dish?.metadata) {
        let metadataObj: any;
        if (typeof dish.metadata === "string") {
          try {
            metadataObj = JSON.parse(dish.metadata);
          } catch (e) {
            metadataObj = {};
          }
        } else {
          metadataObj = dish.metadata;
        }
        ingredients = metadataObj?.ingredients || [];
      }

      for (const ing of ingredients) {
        const quantityToDeduct = Number(ing.quantity) * item.quantity;

        if (!isNaN(quantityToDeduct)) {
          await prisma.inventoryItem.updateMany({
            where: {
              name: ing.name,
              businessId: Number(businessId),
            },
            data: {
              quantity: {
                decrement: quantityToDeduct,
              },
            },
          });
        }
      }
    }

    res.status(201).json({
      order_id: `ORD${order.id.toString().padStart(5, "0")}`,
      table_number: order.tableNumber,
      status: order.status,
      message: "Order placed successfully",
      estimated_time: order.estimatedTime,
      created_at: order.createdAt,
      items: order.items,
    });
  } catch (error) {
    console.error("❌ Error placing order:", error);
    res.status(500).json({ message: "Server error while creating order" });
  }
});

// Fixed GET route for orders with proper date filtering
// COMPLETELY FIXED GET route for exact date filtering
router.get(
  "/",
  authenticateBusinessOwnerJWT,
  async (req: BusinessOwnerRequest, res: Response): Promise<void> => {
    try {
      const businessId = req.businessOwner?.businessId;
      const dateQuery = req.query.date as string;

      if (!businessId) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      let whereClause: any = {
        businessId,
      };

      if (dateQuery) {
        console.log("🗓️ Date query received:", dateQuery);

        // Parse date in IST timezone
        const [year, month, day] = dateQuery.split("-").map(Number);

        // Create start and end of day in IST
        // Start: 00:00:00 IST of selected date
        const startOfDayIST = new Date();
        startOfDayIST.setFullYear(year, month - 1, day);
        startOfDayIST.setHours(0, 0, 0, 0);

        // End: 23:59:59 IST of selected date
        const endOfDayIST = new Date();
        endOfDayIST.setFullYear(year, month - 1, day);
        endOfDayIST.setHours(23, 59, 59, 999);

        // Convert IST to UTC for database query
        // IST is UTC+5:30, so subtract 5.5 hours to get UTC
        const startUTC = new Date(
          startOfDayIST.getTime() - 5.5 * 60 * 60 * 1000
        );
        const endUTC = new Date(endOfDayIST.getTime() - 5.5 * 60 * 60 * 1000);

        whereClause.createdAt = {
          gte: startUTC,
          lte: endUTC,
        };

        console.log("📅 Date filtering:", {
          selectedDate: dateQuery,
          startIST: startOfDayIST.toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
          }),
          endIST: endOfDayIST.toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
          }),
          startUTC: startUTC.toISOString(),
          endUTC: endUTC.toISOString(),
        });
      }

      console.log("🔍 Fetching orders for businessId:", businessId);

      const orders = await prisma.order.findMany({
        where: whereClause,
        include: { items: true },
        orderBy: { createdAt: "desc" },
      });

      console.log(`📊 Found ${orders.length} orders`);

      // Log each order's creation date for debugging
      orders.forEach((order) => {
        console.log(
          `Order ${order.id} created at:`,
          order.createdAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
        );
      });

      // Format response to match frontend expectations
      const formatted = orders.map((order) => {
        const allItemsCompleted = order.items.every(
          (item) => item.status === "Completed"
        );
        const orderStatus =
          allItemsCompleted && order.items.length > 0 ? "Completed" : "Pending";

        return {
          id: order.id,
          order_id: `ORD${order.id.toString().padStart(5, "0")}`,
          tableNumber: order.tableNumber,
          table_number: order.tableNumber,
          totalAmount: order.totalAmount,
          total_amount: order.totalAmount,
          paymentMethod: order.paymentMethod,
          payment_method: order.paymentMethod,
          status: orderStatus,
          estimatedTime: order.estimatedTime,
          estimated_time: order.estimatedTime,
          createdAt: order.createdAt,
          created_at: order.createdAt,
          items: order.items,
        };
      });

      res.status(200).json(formatted);
    } catch (error) {
      console.error("❌ Error fetching orders:", error);
      res.status(500).json({ message: "Server error while fetching orders" });
    }
  }
);

// ✅ GET: Fetch specific order (auth required)
router.get("/:orderId", async (req: Request, res: Response): Promise<void> => {
  const rawId = req.params.orderId;
  const orderId = parseInt(rawId.replace("ORD", ""), 10);

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  // ✅ Calculate order status based on items
  const allItemsCompleted = order.items.every(
    (item) => item.status === "Completed"
  );
  const orderStatus =
    allItemsCompleted && order.items.length > 0 ? "Completed" : "Pending";

  res.status(200).json({
    order_id: `ORD${order.id.toString().padStart(5, "0")}`,
    table_number: order.tableNumber,
    total_amount: order.totalAmount,
    payment_method: order.paymentMethod,
    status: orderStatus, // ✅ Dynamic status based on items
    estimated_time: order.estimatedTime,
    created_at: order.createdAt,
    items: order.items,
  });
});

// ✅ PUT: Update order (no auth)
router.put("/:orderId", async (req: Request, res: Response): Promise<void> => {
  try {
    const rawId = req.params.orderId;
    const orderId = parseInt(rawId.replace("ORD", ""), 10);
    const {
      businessId,
      table_number,
      cart_items,
      total_amount,
      payment_method,
      estimated_time,
    } = req.body;

    if (!businessId) {
      res.status(400).json({ message: "Missing business ID" });
      return;
    }

    const existingOrder = await prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!existingOrder || existingOrder.businessId !== businessId) {
      res.status(403).json({ message: "Not allowed to update this order" });
      return;
    }

    // Fetch existing items with status
    const existingItems = await prisma.orderItem.findMany({
      where: { orderId },
    });

    // Delete old items
    await prisma.orderItem.deleteMany({ where: { orderId } });

    // Create new items, preserving status if they existed
    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        tableNumber: table_number,
        totalAmount: total_amount,
        paymentMethod: payment_method,
        estimatedTime: estimated_time,
        items: {
          create: cart_items.map((item: any) => {
            const matched = existingItems.find(
              (existing) => existing.productId === item.productId
            );

            return {
              productId: item.productId,
              quantity: item.quantity,
              price: item.price,
              name: item.name,
              status: item.status || matched?.status || "Pending", // ✅ Preserve if exists
            };
          }),
        },
      },
      include: { items: true },
    });

    res.status(200).json({
      order_id: `ORD${updated.id.toString().padStart(5, "0")}`,
      table_number: updated.tableNumber,
      total_amount: updated.totalAmount,
      payment_method: updated.paymentMethod,
      status: "Pending", // ✅ Reset order status on update
      estimated_time: updated.estimatedTime,
      items: updated.items,
      message: "Order updated successfully",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error while updating order" });
  }
});

// ✅ PATCH: Update order status (auth required)
router.patch(
  "/:orderId/status",
  authenticateBusinessOwnerJWT,
  async (req: BusinessOwnerRequest, res: Response): Promise<void> => {
    try {
      const rawId = req.params.orderId;
      const orderId = parseInt(rawId.replace("ORD", ""), 10);
      const { status } = req.body;

      const businessId = req.businessOwner?.businessId; // ✅ Use JWT payload

      if (!businessId) {
        res.status(401).json({ message: "Unauthorized: Missing businessId" });
        return;
      }

      const existingOrder = await prisma.order.findUnique({
        where: { id: orderId },
      });

      if (!existingOrder || existingOrder.businessId !== businessId) {
        res.status(403).json({ message: "Not allowed to update this order" });
        return;
      }

      const updatedOrder = await prisma.order.update({
        where: { id: orderId },
        data: { status },
        include: { items: true },
      });

      res.status(200).json({
        order_id: `ORD${updatedOrder.id.toString().padStart(5, "0")}`,
        status: updatedOrder.status,
        message: "Order status updated successfully",
      });
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ message: "Server error while updating order status" });
    }
  }
);

// ✅ NEW: Update individual item status
router.patch(
  "/:orderId/items/:productId/status",
  authenticateBusinessOwnerJWT,
  async (req: BusinessOwnerRequest, res: Response): Promise<void> => {
    try {
      const rawId = req.params.orderId;
      const orderId = parseInt(rawId.replace("ORD", ""), 10);
      const productId = parseInt(req.params.productId, 10);
      const { status } = req.body;

      const businessId = req.businessOwner?.businessId;

      if (!businessId) {
        res.status(401).json({ message: "Unauthorized: Missing businessId" });
        return;
      }

      // Verify order belongs to business
      const existingOrder = await prisma.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });

      if (!existingOrder || existingOrder.businessId !== businessId) {
        res.status(403).json({ message: "Not allowed to update this order" });
        return;
      }

      // Find and update the specific item
      const itemToUpdate = existingOrder.items.find(
        (item) => item.productId === productId
      );

      if (!itemToUpdate) {
        res.status(404).json({ message: "Item not found in order" });
        return;
      }

      // Update the item status
      await prisma.orderItem.updateMany({
        where: {
          orderId: orderId,
          productId: productId,
        },
        data: {
          status: status,
        },
      });

      // Get updated order with items
      const updatedOrder = await prisma.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });

      if (!updatedOrder) {
        res.status(404).json({ message: "Order not found" });
        return;
      }

      // Calculate new order status based on all items
      const allItemsCompleted = updatedOrder.items.every(
        (item) => item.status === "Completed"
      );
      const newOrderStatus =
        allItemsCompleted && updatedOrder.items.length > 0
          ? "Completed"
          : "Pending";

      // Update order status if needed
      await prisma.order.update({
        where: { id: orderId },
        data: { status: newOrderStatus },
      });

      res.status(200).json({
        message: "Item status updated successfully",
        item: {
          productId: productId,
          status: status,
        },
        orderStatus: newOrderStatus,
      });
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ message: "Server error while updating item status" });
    }
  }
);

// ✅ NEW: Serve all items in an order
router.patch(
  "/:orderId/complete-all",
  authenticateBusinessOwnerJWT,
  async (req: BusinessOwnerRequest, res: Response): Promise<void> => {
    try {
      const rawId = req.params.orderId;
      const orderId = parseInt(rawId.replace("ORD", ""), 10);

      const businessId = req.businessOwner?.businessId;

      if (!businessId) {
        res.status(401).json({ message: "Unauthorized: Missing businessId" });
        return;
      }

      // Verify order belongs to business
      const existingOrder = await prisma.order.findUnique({
        where: { id: orderId },
      });

      if (!existingOrder || existingOrder.businessId !== businessId) {
        res.status(403).json({ message: "Not allowed to update this order" });
        return;
      }

      // Update all items to "Completed"
      await prisma.orderItem.updateMany({
        where: {
          orderId: orderId,
        },
        data: {
          status: "Completed",
        },
      });

      // Update order status to "Completed"
      await prisma.order.update({
        where: { id: orderId },
        data: { status: "Completed" },
      });

      res.status(200).json({
        message: "All items marked as completed successfully",
        orderStatus: "Completed",
      });
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ message: "Server error while completing all items" });
    }
  }
);

export default router;
