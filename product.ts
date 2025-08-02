import upload from "../middleware/multer";
import { Router, Request, Response } from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import { authenticateBusinessOwnerJWT } from "../middleware/authenticateJWT";
import { BusinessOwnerRequest } from "../middleware/authenticateJWT";

const router = Router();
const prisma = new PrismaClient();

// ✅ Protect the POST route
router.post(
  "/",
  authenticateBusinessOwnerJWT,
  upload.array("images", 10),
  async (req: BusinessOwnerRequest, res: Response): Promise<void> => {
    try {
      const { name, description, price, productType, category, metadata } =
        req.body;

      const businessId = req.businessOwner?.businessId; // ✅ Get businessId from logged-in user
      if (!name || !price || !businessId) {
        res.status(400).json({ error: "Missing required fields" });
        return;
      }

      const files = req.files as Express.Multer.File[] | undefined;

      if (!files || files.length === 0) {
        res.status(400).json({ error: "Images upload failed or missing" });
        return;
      }

      const imageUrls = files.map((file) => file.path);

      let parsedMetadata = {};
      if (metadata) {
        try {
          parsedMetadata =
            typeof metadata === "string" ? JSON.parse(metadata) : metadata;
        } catch (e) {
          console.warn("Failed to parse metadata JSON:", e);
        }
      }

      const finalMetadata = {
        ...parsedMetadata,
        images: imageUrls,
      };

      const product = await prisma.product.create({
        data: {
          name,
          description,
          price: Number(price),
          businessId, // ✅ Use businessId from req.businessOwner
          productType: productType || "generic",
          category: category || null,
          metadata: finalMetadata,
          isActive: true,
        },
      });

      res.status(201).json(product);
    } catch (error) {
      console.error("Create product error:", error);
      res.status(500).json({ error: "Failed to create product" });
    }
  }
);

// ✅ Protect GET all route and filter products by user's businessId
// GET /api/products?businessId=1
router.get(
  "/",
  async (req: BusinessOwnerRequest, res: Response): Promise<void> => {
    try {
      const queryBusinessId = req.query.businessId as string;

      if (!queryBusinessId || isNaN(Number(queryBusinessId))) {
        res.status(400).json({ error: "Valid Business ID is required" });
        return;
      }

      const products = await prisma.product.findMany({
        where: { businessId: Number(queryBusinessId) },
      });

      res.json(products);
    } catch (error) {
      console.error("Get products error:", error);
      res.status(500).json({ error: "Failed to fetch products" });
    }
  }
);

// ✅ Protect GET by ID route and ensure product belongs to user
router.get(
  "/:id",
  authenticateBusinessOwnerJWT,
  async (req: BusinessOwnerRequest, res: Response): Promise<void> => {
    try {
      const id = Number(req.params.id);
      const businessId = req.businessOwner?.businessId; // ✅ Restrict access

      const product = await prisma.product.findFirst({
        where: { id, businessId },
        include: { business: true },
      });

      if (!product) {
        res.status(404).json({ error: "Product not found or not authorized" });
        return;
      }

      res.json(product);
    } catch (error) {
      console.error("Get product error:", error);
      res.status(500).json({ error: "Failed to fetch product" });
    }
  }
);

// ✅ Protect PUT route and verify ownership
router.put(
  "/:id",
  authenticateBusinessOwnerJWT,
  upload.array("images", 10),
  async (req: BusinessOwnerRequest, res: Response): Promise<void> => {
    try {
      const id = Number(req.params.id);
      const businessId = req.businessOwner?.businessId;

      const {
        name,
        description,
        price,
        productType,
        category,
        metadata,
        isActive,
      } = req.body;

      let parsedMetadata: any = {};
      if (metadata) {
        try {
          parsedMetadata =
            typeof metadata === "string" ? JSON.parse(metadata) : metadata;
        } catch (e) {
          console.warn("Failed to parse metadata JSON:", e);
        }
      }

      const files = req.files as Express.Multer.File[] | undefined;
      const newImageUrls = files ? files.map((file) => file.path) : [];

      const existingProduct = await prisma.product.findFirst({
        where: { id, businessId }, // ✅ Only fetch product owned by user
      });

      if (!existingProduct) {
        res.status(404).json({ error: "Product not found or not authorized" });
        return;
      }

      let oldImages: string[] = [];
      if (
        existingProduct?.metadata &&
        typeof existingProduct.metadata === "object" &&
        !Array.isArray(existingProduct.metadata) &&
        "images" in existingProduct.metadata &&
        Array.isArray(existingProduct.metadata.images)
      ) {
        oldImages = existingProduct.metadata.images.filter(
          (img): img is string => typeof img === "string"
        );
      }

      if (newImageUrls.length > 0) {
        parsedMetadata.images = newImageUrls;
      } else if (oldImages.length > 0) {
        parsedMetadata.images = oldImages;
      }

      const updateData: any = {
        name,
        description,
        price: price !== undefined ? Number(price) : undefined,
        productType,
        category: category || undefined,
        metadata: parsedMetadata,
      };

      if (isActive !== undefined) {
        updateData.isActive = isActive === "true" || isActive === true;
      }

      Object.keys(updateData).forEach((key) => {
        if (updateData[key] === undefined) delete updateData[key];
      });

      const updatedProduct = await prisma.product.update({
        where: { id },
        data: updateData,
      });

      res.json(updatedProduct);
    } catch (error) {
      console.error("Update product error:", error);
      res.status(500).json({ error: "Failed to update product" });
    }
  }
);

// ✅ Protect DELETE and check ownership
router.delete(
  "/:id",
  authenticateBusinessOwnerJWT,
  async (req: BusinessOwnerRequest, res: Response): Promise<void> => {
    try {
      const id = Number(req.params.id);
      const businessId = req.businessOwner?.businessId;

      if (!businessId) {
        console.error("Business ID missing from user token");
        res.status(403).json({ error: "Unauthorized - Business ID missing" });
        return;
      }

      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid product ID" });
        return;
      }

      // 💡 Optional: Add debug logging
      console.log(
        "Attempting to delete product",
        id,
        "for business",
        businessId
      );
      console.log("req.businessOwner:", req.businessOwner);

      const existingProduct = await prisma.product.findFirst({
        where: { id, businessId }, // ✅ Restrict deletion to owned product
      });

      if (!existingProduct) {
        res.status(404).json({ error: "Product not found or not authorized" });
        return;
      }

      await prisma.product.delete({ where: { id } });
      res.json({ message: "Product deleted successfully" });
    } catch (error) {
      console.error("Delete product error:", error);
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        console.error("Prisma error code:", error.code);
      }
      res.status(500).json({
        error: "Failed to delete product",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

export default router;
