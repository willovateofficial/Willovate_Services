import { Request, Response } from "express";
import express from "express";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

// Create or update table
router.post("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const { businessId, tableNumber } = req.body;

    if (!businessId || !tableNumber) {
      res.status(400).json({ error: "Missing businessId or tableNumber" });
      return;
    }

    const table = await prisma.table.upsert({
      where: {
        tableNumber_businessId: {
          tableNumber: Number(tableNumber),
          businessId: Number(businessId),
        },
      },
      update: {},
      create: {
        tableNumber: Number(tableNumber),
        businessId: Number(businessId),
      },
    });

    res.json({ success: true, table });
  } catch (error) {
    console.error("Error creating table:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Get tables and mark status
router.get(
  "/:businessId",
  async (req: Request, res: Response): Promise<void> => {
    const { businessId } = req.params;

    if (!businessId) {
      res.status(400).json({ error: "Missing businessId" });
      return;
    }

    try {
      const allTables = await prisma.table.findMany({
        where: { businessId: Number(businessId) },
        orderBy: { tableNumber: "asc" },
      });

      const activeOrders = await prisma.order.findMany({
        where: {
          businessId: Number(businessId),
          status: {
            not: "Completed", // Only consider non-completed orders
          },
        },
        select: { tableNumber: true },
      });

      const bookedTableNumbers = new Set(
        activeOrders.map((order) => order.tableNumber)
      );

      const tablesWithStatus = allTables.map((table) => ({
        id: table.id,
        tableNumber: table.tableNumber,
        status: bookedTableNumbers.has(table.tableNumber)
          ? "Booked"
          : "Available",
      }));

      res.json({ tables: tablesWithStatus });
    } catch (error) {
      console.error("Error fetching tables:", error);
      res.status(500).json({ error: "Failed to fetch tables" });
    }
  }
);

export default router;
