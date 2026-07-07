-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "wholesaleTag" TEXT NOT NULL DEFAULT 'wholesale_approved',
    "pendingTag" TEXT NOT NULL DEFAULT 'wholesale_pending',
    "vipTag" TEXT NOT NULL DEFAULT 'vip_wholesale',
    "applicationMode" TEXT NOT NULL DEFAULT 'manual',
    "storewidePercentOff" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "minimumSubtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "minCartQuantity" INTEGER NOT NULL DEFAULT 1,
    "enforceMinCartQty" BOOLEAN NOT NULL DEFAULT false,
    "lockWholesaleAccess" BOOLEAN NOT NULL DEFAULT false,
    "autoCreateDiscount" BOOLEAN NOT NULL DEFAULT false,
    "wholesaleDiscountId" TEXT,
    "validationOwnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WholesaleRule" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "customerTag" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT,
    "scopeLabel" TEXT,
    "discountType" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "minQuantity" INTEGER NOT NULL DEFAULT 1,
    "minProductQuantity" INTEGER,
    "minCartQuantity" INTEGER,
    "minSubtotal" DOUBLE PRECISION,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "settingsId" INTEGER,

    CONSTRAINT "WholesaleRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WholesaleApplication" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "companyName" TEXT,
    "phone" TEXT,
    "taxId" TEXT,
    "resaleNumber" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "settingsId" INTEGER,

    CONSTRAINT "WholesaleApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRule" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "customerTag" TEXT,
    "productTag" TEXT,
    "productGid" TEXT,
    "variantGid" TEXT,
    "sku" TEXT,
    "minQty" INTEGER NOT NULL DEFAULT 1,
    "discountType" TEXT NOT NULL DEFAULT 'fixed_price',
    "sellPrice" DOUBLE PRECISION,
    "percentOff" DOUBLE PRECISION,
    "unitCost" DOUBLE PRECISION,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostCalculator" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "materialCost" DOUBLE PRECISION NOT NULL,
    "printCost" DOUBLE PRECISION NOT NULL,
    "laborCost" DOUBLE PRECISION NOT NULL,
    "machineCost" DOUBLE PRECISION NOT NULL,
    "wastePercent" DOUBLE PRECISION NOT NULL,
    "packagingCost" DOUBLE PRECISION NOT NULL,
    "setupFee" DOUBLE PRECISION NOT NULL,
    "suggestedMargin" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostCalculator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerName" TEXT,
    "company" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "depositAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "balanceDue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "depositCreated" BOOLEAN NOT NULL DEFAULT false,
    "balanceCreated" BOOLEAN NOT NULL DEFAULT false,
    "fullOrderCreated" BOOLEAN NOT NULL DEFAULT false,
    "depositDraftOrderId" TEXT,
    "balanceDraftOrderId" TEXT,
    "fullDraftOrderId" TEXT,
    "depositInvoiceUrl" TEXT,
    "balanceInvoiceUrl" TEXT,
    "fullInvoiceUrl" TEXT,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteItem" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "variant" TEXT,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "unitCost" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,
    "productImageUrl" TEXT,
    "artworkUrl" TEXT,
    "proofUrl" TEXT,
    "shopifyProductGid" TEXT,
    "shopifyVariantGid" TEXT,
    "recipeId" TEXT,
    "recipeName" TEXT,
    "selectedFinish" TEXT,
    "selectedAddOnIds" TEXT,
    "pricingSource" TEXT,
    "tierLabel" TEXT,
    "minQuantity" INTEGER,
    "marginPct" DOUBLE PRECISION,
    "costSnapshot" TEXT,
    "priceSnapshot" TEXT,

    CONSTRAINT "QuoteItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCost" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL DEFAULT '',
    "productId" TEXT,
    "variantId" TEXT,
    "sku" TEXT,
    "productName" TEXT,
    "name" TEXT,
    "materialCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "printCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "laborCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "machineCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "packagingCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "customCosts" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCategory" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Material" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "categoryId" TEXT,
    "name" TEXT NOT NULL,
    "materialType" TEXT NOT NULL DEFAULT 'general',
    "productFamilies" TEXT NOT NULL DEFAULT '',
    "costReviewNeeded" BOOLEAN NOT NULL DEFAULT false,
    "useInRecipes" BOOLEAN NOT NULL DEFAULT true,
    "unit" TEXT NOT NULL DEFAULT 'each',
    "costPerUnit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "vendor" TEXT,
    "primaryVendorId" TEXT,
    "sku" TEXT,
    "stockOnHand" DOUBLE PRECISION,
    "reorderPoint" DOUBLE PRECISION,
    "leadTimeDays" INTEGER,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "purchaseUnit" TEXT NOT NULL DEFAULT 'each',
    "purchaseCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "baseUnit" TEXT NOT NULL DEFAULT 'each',
    "yieldQuantity" DOUBLE PRECISION,
    "yieldUnit" TEXT,
    "rollWidthIn" DOUBLE PRECISION,
    "rollLengthFt" DOUBLE PRECISION,
    "volumeMl" DOUBLE PRECISION,
    "caseQuantity" DOUBLE PRECISION,
    "calculatedUnitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialVariant" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "sku" TEXT,
    "stockOnHand" DOUBLE PRECISION,
    "reorderPoint" DOUBLE PRECISION,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductTypeProfile" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "productionMode" TEXT NOT NULL DEFAULT 'in_house',
    "minQuantity" INTEGER NOT NULL DEFAULT 1,
    "defaultQuantity" INTEGER NOT NULL DEFAULT 1,
    "tierBreakpoints" TEXT NOT NULL DEFAULT '1',
    "tierTemplate" TEXT,
    "defaultMarginPct" DOUBLE PRECISION NOT NULL DEFAULT 40,
    "pricingMethod" TEXT NOT NULL DEFAULT 'auto_margin',
    "defaultTags" TEXT,
    "calculatorKind" TEXT,
    "calculatorRoutesJson" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductTypeProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductRecipe" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "categoryId" TEXT,
    "productTypeProfileId" TEXT,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "productType" TEXT NOT NULL DEFAULT 'label',
    "productFamily" TEXT NOT NULL DEFAULT 'Labels',
    "pricingTemplateMode" TEXT NOT NULL DEFAULT 'template',
    "costReviewNeeded" BOOLEAN NOT NULL DEFAULT false,
    "costReviewReasons" TEXT,
    "costReviewSyncedAt" TIMESTAMP(3),
    "costReviewSource" TEXT,
    "useInQuotes" BOOLEAN NOT NULL DEFAULT true,
    "applicationLaborSecondsPerUnit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "packingLaborSecondsPerUnit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "prepressMinutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "productGid" TEXT,
    "variantGid" TEXT,
    "shopifyProductId" TEXT,
    "shopifyVariantId" TEXT,
    "shopifyTargetMode" TEXT NOT NULL DEFAULT 'product_all_variants',
    "shopifyVariantIds" TEXT,
    "costMethod" TEXT NOT NULL DEFAULT 'recipe',
    "productionMode" TEXT NOT NULL DEFAULT 'in_house',
    "vendorProductId" TEXT,
    "widthIn" DOUBLE PRECISION,
    "heightIn" DOUBLE PRECISION,
    "depthIn" DOUBLE PRECISION,
    "minQuantity" INTEGER NOT NULL DEFAULT 1,
    "defaultQuantity" INTEGER NOT NULL DEFAULT 1000,
    "baseCmykCoveragePct" DOUBLE PRECISION NOT NULL DEFAULT 40,
    "inkAllowancePct" DOUBLE PRECISION NOT NULL DEFAULT 15,
    "maintenanceCostPerSqft" DOUBLE PRECISION NOT NULL DEFAULT 0.08,
    "machineRecoveryCostPerSqft" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "overheadCostPerSqft" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "operatorLaborPct" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "defaultSellPrice" DOUBLE PRECISION,
    "targetMarginPct" DOUBLE PRECISION NOT NULL DEFAULT 40,
    "wastePct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "setupCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "laborMinutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductRecipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorProduct" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "productType" TEXT NOT NULL DEFAULT 'sourced_product',
    "vendor" TEXT,
    "vendorId" TEXT,
    "vendorSku" TEXT,
    "moq" INTEGER NOT NULL DEFAULT 1,
    "defaultUnitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "leadTimeDays" INTEGER,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorProductTier" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "vendorProductId" TEXT NOT NULL,
    "minQty" INTEGER NOT NULL,
    "maxQty" INTEGER,
    "unitCost" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorProductTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorProductAddOn" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "vendorProductId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pricingType" TEXT NOT NULL DEFAULT 'per_unit',
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorProductAddOn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeVariantRule" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shopifyProductGid" TEXT,
    "shopifyVariantGid" TEXT,
    "shopifyVariantTitle" TEXT,
    "sku" TEXT,
    "sideMode" TEXT NOT NULL DEFAULT 'single',
    "bagColor" TEXT,
    "frontMediaOptionId" TEXT,
    "backMediaMode" TEXT NOT NULL DEFAULT 'same_as_front',
    "backMediaOptionId" TEXT,
    "useFrontZone" BOOLEAN NOT NULL DEFAULT true,
    "useBackZone" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeVariantRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeMediaOption" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "defaultOption" BOOLEAN NOT NULL DEFAULT false,
    "premiumOption" BOOLEAN NOT NULL DEFAULT false,
    "priceAdjustPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priceAdjustFlat" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeMediaOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeLabelZone" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "materialId" TEXT,
    "mediaMode" TEXT NOT NULL DEFAULT 'fixed',
    "mediaOptionId" TEXT,
    "sameAsZoneId" TEXT,
    "name" TEXT NOT NULL,
    "position" TEXT,
    "widthIn" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "heightIn" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qtyPerUnit" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "applicationSecondsPerLabel" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeLabelZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeMaterial" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "usageType" TEXT NOT NULL DEFAULT 'media',
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'sqft',
    "wastePct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "includeWaste" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeInkRequirement" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "inkType" TEXT NOT NULL,
    "coveragePercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeInkRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeMachineRule" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "preferredMachineId" TEXT,
    "requiredInkTypes" TEXT,
    "allowOverflow" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeMachineRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeTier" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "minQty" INTEGER NOT NULL,
    "maxQty" INTEGER,
    "marginPct" DOUBLE PRECISION,
    "fixedPrice" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeAddOn" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pricingType" TEXT NOT NULL DEFAULT 'per_unit',
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeAddOn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourcedCostTier" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "minQty" INTEGER NOT NULL,
    "unitCost" DOUBLE PRECISION NOT NULL,
    "vendor" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourcedCostTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialCostHistory" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "oldCost" DOUBLE PRECISION NOT NULL,
    "newCost" DOUBLE PRECISION NOT NULL,
    "vendor" TEXT,
    "reason" TEXT,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialCostHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialVendor" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "vendorName" TEXT NOT NULL,
    "vendorSku" TEXT,
    "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'each',
    "moq" DOUBLE PRECISION,
    "leadTimeDays" INTEGER,
    "notes" TEXT,
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialVendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Machine" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "machineType" TEXT NOT NULL DEFAULT 'printer',
    "maxWidthIn" DOUBLE PRECISION,
    "costPerHour" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sqftPerHour" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "setupWastePct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "allowOverflow" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Machine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineInkChannel" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "slotNumber" INTEGER NOT NULL,
    "inkName" TEXT NOT NULL,
    "inkType" TEXT NOT NULL,
    "costPerMl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cartridgeCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cartridgeMl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mlPerSqft1Pct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mlPerSqft100" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineInkChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionJob" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "quoteId" TEXT,
    "quoteNumber" TEXT,
    "jobTicket" TEXT,
    "assetInboxKey" TEXT,
    "assetFolderUrl" TEXT,
    "sourceFolderUrl" TEXT,
    "lastAssetSyncAt" TIMESTAMP(3),
    "customerName" TEXT,
    "company" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "dueDate" TIMESTAMP(3),
    "assignedTo" TEXT,
    "customerNotes" TEXT,
    "internalNotes" TEXT,
    "artworkUrl" TEXT,
    "proofUrl" TEXT,
    "printFileUrl" TEXT,
    "productImageUrl" TEXT,
    "proofApprovalToken" TEXT,
    "proofStatus" TEXT NOT NULL DEFAULT 'draft',
    "proofSentAt" TIMESTAMP(3),
    "proofViewedAt" TIMESTAMP(3),
    "proofApprovedAt" TIMESTAMP(3),
    "proofRejectedAt" TIMESTAMP(3),
    "proofCustomerName" TEXT,
    "proofCustomerEmail" TEXT,
    "proofCustomerComment" TEXT,
    "actualLaborMinutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actualLaborRate" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "actualLaborCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actualPackingCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actualShippingCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actualOutsourceCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actualOtherCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actualReprintCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actualTotalCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actualFinalProfit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actualFinalMargin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actualCostNotes" TEXT,
    "actualCostFinalized" BOOLEAN NOT NULL DEFAULT false,
    "actualCostFinalizedAt" TIMESTAMP(3),
    "actualCostFinalizedBy" TEXT,
    "alertSentAt" TIMESTAMP(3),
    "printedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionJobItem" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "quoteItemId" TEXT,
    "itemTicket" TEXT,
    "ripJobName" TEXT,
    "suggestedFileName" TEXT,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "shopifyProductGid" TEXT,
    "shopifyVariantGid" TEXT,
    "productImageUrl" TEXT,
    "recipeId" TEXT,
    "recipeName" TEXT,
    "selectedFinish" TEXT,
    "selectedAddOns" TEXT,
    "materialSummary" TEXT,
    "machineSummary" TEXT,
    "costSnapshot" TEXT,
    "priceSnapshot" TEXT,
    "productionNotes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductionJobItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionJobFile" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL DEFAULT 'artwork',
    "fileUrl" TEXT NOT NULL,
    "assetRole" TEXT NOT NULL DEFAULT 'reference',
    "assetSource" TEXT NOT NULL DEFAULT 'manual',
    "sourceRef" TEXT,
    "matchedBy" TEXT,
    "jobTicket" TEXT,
    "originalFileName" TEXT,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionJobFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionJobEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionJobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionChecklistItem" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "section" TEXT NOT NULL DEFAULT 'production',
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "completedBy" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductionChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionMaterialUsage" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "materialId" TEXT,
    "materialName" TEXT NOT NULL,
    "materialType" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'sqft',
    "estimatedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pulledQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "usedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "wasteQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reprintQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costPerUnit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "stockDeductedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stockDeductedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductionMaterialUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialInventoryMovement" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "jobId" TEXT,
    "materialUsageId" TEXT,
    "movementType" TEXT NOT NULL DEFAULT 'adjustment',
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'each',
    "beforeQty" DOUBLE PRECISION,
    "afterQty" DOUBLE PRECISION,
    "costPerUnit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costImpact" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'production',
    "reference" TEXT,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialInventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintLogImport" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "fileName" TEXT,
    "importedBy" TEXT,
    "rawText" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "unmatchedCount" INTEGER NOT NULL DEFAULT 0,
    "totalSqft" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalInkMl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPrintMinutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'processed',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrintLogImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintLogEntry" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "productionJobId" TEXT,
    "productionJobItemId" TEXT,
    "jobTicket" TEXT,
    "sourceJobName" TEXT,
    "printerSoftware" TEXT,
    "machineName" TEXT,
    "mediaName" TEXT,
    "status" TEXT,
    "sqft" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "inkMl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cmykInkMl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "whiteInkMl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "glossInkMl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "printMinutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "rawRow" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrintLogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintLogAutoImportSetting" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "uploadToken" TEXT NOT NULL,
    "incomingFolder" TEXT,
    "versaworksFolder" TEXT,
    "rasterlinkFolder" TEXT,
    "processedFolder" TEXT,
    "errorFolder" TEXT,
    "expectedTicketPattern" TEXT NOT NULL DEFAULT 'GSO-{date}-{jobNumber}-{sku}-{qty}',
    "lastAutoImportAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintLogAutoImportSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRequest" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "materialId" TEXT,
    "materialName" TEXT NOT NULL,
    "materialType" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'each',
    "sku" TEXT,
    "vendor" TEXT,
    "vendorId" TEXT,
    "vendorSku" TEXT,
    "moq" DOUBLE PRECISION,
    "leadTimeDays" INTEGER,
    "requestedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "orderedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "receivedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "estimatedCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "neededBy" TIMESTAMP(3),
    "orderedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "sentBy" TEXT,
    "vendorConfirmationNumber" TEXT,
    "expectedArrivalDate" TIMESTAMP(3),
    "vendorReplyNotes" TEXT,
    "followUpNeeded" BOOLEAN NOT NULL DEFAULT false,
    "followUpDate" TIMESTAMP(3),
    "lastFollowUpAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vendorType" TEXT NOT NULL DEFAULT 'supplier',
    "status" TEXT NOT NULL DEFAULT 'active',
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "address1" TEXT,
    "address2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "country" TEXT DEFAULT 'USA',
    "paymentTerms" TEXT,
    "leadTimeDays" INTEGER,
    "moqNotes" TEXT,
    "shippingNotes" TEXT,
    "qualityNotes" TEXT,
    "notes" TEXT,
    "defaultCurrency" TEXT NOT NULL DEFAULT 'USD',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorContact" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorCostBookItem" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "vendorId" TEXT,
    "vendorName" TEXT,
    "itemType" TEXT NOT NULL DEFAULT 'material',
    "materialId" TEXT,
    "vendorProductId" TEXT,
    "itemName" TEXT NOT NULL,
    "vendorSku" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'each',
    "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "moq" DOUBLE PRECISION,
    "leadTimeDays" INTEGER,
    "effectiveDate" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorCostBookItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorCostBookTier" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "vendorCostBookItemId" TEXT NOT NULL,
    "minQty" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "maxQty" DOUBLE PRECISION,
    "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorCostBookTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpAdminSetting" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL DEFAULT '',
    "valueType" TEXT NOT NULL DEFAULT 'text',
    "unit" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpAdminSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceApprovalRecord" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'margin_review',
    "variantRuleId" TEXT NOT NULL,
    "recipeId" TEXT,
    "recipeName" TEXT,
    "shopifyProductGid" TEXT,
    "shopifyVariantGid" TEXT,
    "productTitle" TEXT,
    "variantTitle" TEXT,
    "currentPrice" DOUBLE PRECISION,
    "suggestedPrice" DOUBLE PRECISION NOT NULL,
    "estimatedCost" DOUBLE PRECISION NOT NULL,
    "targetMarginPct" DOUBLE PRECISION,
    "currentMarginPct" DOUBLE PRECISION,
    "delta" DOUBLE PRECISION,
    "action" TEXT NOT NULL DEFAULT 'Review price',
    "status" TEXT NOT NULL DEFAULT 'needs_review',
    "reason" TEXT,
    "costReviewNeeded" BOOLEAN NOT NULL DEFAULT false,
    "tierIssues" INTEGER NOT NULL DEFAULT 0,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "updatedInShopifyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceApprovalRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentReviewQueueItem" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'agent',
    "status" TEXT NOT NULL DEFAULT 'new',
    "reviewLevel" TEXT NOT NULL DEFAULT 'basic_staff_review',
    "customerName" TEXT,
    "company" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "preferredContactMethod" TEXT,
    "productFamily" TEXT,
    "productType" TEXT,
    "quantity" TEXT,
    "dimensionsOrSize" TEXT,
    "materialOrSubstrate" TEXT,
    "finish" TEXT,
    "deadline" TEXT,
    "shippingCityState" TEXT,
    "contact" JSONB,
    "productRequest" JSONB,
    "missingFields" JSONB,
    "escalationReasons" JSONB,
    "customerSafeSummary" TEXT,
    "customerSafeDraftReply" TEXT,
    "internalNotes" TEXT,
    "recommendedStaffAction" TEXT,
    "originalAgentDraftSnapshot" JSONB,
    "normalizedDraft" JSONB,
    "staffEditedDraft" JSONB,
    "createdBy" TEXT NOT NULL DEFAULT 'agent',
    "assignedStaffId" TEXT,
    "assignedStaffName" TEXT,
    "assignedStaffEmail" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "convertedBy" TEXT,
    "convertedAt" TIMESTAMP(3),
    "convertedQuoteId" TEXT,
    "requiresStaffApproval" BOOLEAN NOT NULL DEFAULT true,
    "canBecomeRealQuoteAutomatically" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentReviewQueueItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentReviewQueueEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "queueItemId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorType" TEXT NOT NULL DEFAULT 'system',
    "actorId" TEXT,
    "actorName" TEXT,
    "actorEmail" TEXT,
    "message" TEXT,
    "beforeSnapshot" JSONB,
    "afterSnapshot" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentReviewQueueEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentApiCredential" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "agentEmail" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceChannel" TEXT,
    "tokenId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "hmacSecretHash" TEXT,
    "scopes" JSONB,
    "allowedProductFamilies" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIpHash" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentApiCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSubmissionLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT,
    "credentialId" TEXT,
    "agentId" TEXT,
    "agentName" TEXT,
    "sourceChannel" TEXT,
    "externalLeadId" TEXT,
    "idempotencyKey" TEXT,
    "requestId" TEXT,
    "status" TEXT NOT NULL,
    "outcome" TEXT,
    "queueItemId" TEXT,
    "errorCode" TEXT,
    "ipHash" TEXT,
    "userAgentHash" TEXT,
    "payloadHash" TEXT,
    "safeSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentSubmissionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarginReviewSetting" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "laborRatePerHour" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "applicationLaborFloorPerSide" DOUBLE PRECISION NOT NULL DEFAULT 0.20,
    "auditRowLimit" INTEGER NOT NULL DEFAULT 150,
    "warningBandPct" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "costReviewThresholdPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarginReviewSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfiguratorProduct" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "productType" TEXT NOT NULL DEFAULT 'stock_bag_4x5',
    "shopifyProductGid" TEXT,
    "shopifyVariantGid" TEXT,
    "shopifyHandle" TEXT,
    "sku" TEXT,
    "defaultSides" TEXT NOT NULL DEFAULT 'Double Sided',
    "minQuantity" INTEGER NOT NULL DEFAULT 64,
    "pilot" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfiguratorProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfiguratorOption" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productType" TEXT NOT NULL DEFAULT 'stock_bag_4x5',
    "group" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfiguratorOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfiguratorPricingRule" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productType" TEXT NOT NULL DEFAULT 'stock_bag_4x5',
    "material" TEXT NOT NULL,
    "finish" TEXT NOT NULL,
    "productionFinish" TEXT NOT NULL,
    "sides" TEXT NOT NULL DEFAULT 'Double Sided',
    "minQty" INTEGER NOT NULL,
    "maxQty" INTEGER,
    "priceEach" DOUBLE PRECISION NOT NULL,
    "costEach" DOUBLE PRECISION NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfiguratorPricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");

-- CreateIndex
CREATE INDEX "WholesaleRule_shop_active_idx" ON "WholesaleRule"("shop", "active");

-- CreateIndex
CREATE INDEX "WholesaleRule_shop_customerTag_idx" ON "WholesaleRule"("shop", "customerTag");

-- CreateIndex
CREATE INDEX "WholesaleRule_shop_scopeType_scopeId_idx" ON "WholesaleRule"("shop", "scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "WholesaleApplication_shop_status_idx" ON "WholesaleApplication"("shop", "status");

-- CreateIndex
CREATE INDEX "PricingRule_shop_active_idx" ON "PricingRule"("shop", "active");

-- CreateIndex
CREATE INDEX "PricingRule_shop_customerTag_idx" ON "PricingRule"("shop", "customerTag");

-- CreateIndex
CREATE INDEX "PricingRule_shop_productTag_idx" ON "PricingRule"("shop", "productTag");

-- CreateIndex
CREATE INDEX "PricingRule_shop_variantGid_idx" ON "PricingRule"("shop", "variantGid");

-- CreateIndex
CREATE INDEX "PricingRule_shop_sku_idx" ON "PricingRule"("shop", "sku");

-- CreateIndex
CREATE INDEX "Quote_shop_status_idx" ON "Quote"("shop", "status");

-- CreateIndex
CREATE INDEX "Quote_shop_createdAt_idx" ON "Quote"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "QuoteItem_quoteId_idx" ON "QuoteItem"("quoteId");

-- CreateIndex
CREATE INDEX "QuoteItem_recipeId_idx" ON "QuoteItem"("recipeId");

-- CreateIndex
CREATE INDEX "QuoteItem_sku_idx" ON "QuoteItem"("sku");

-- CreateIndex
CREATE INDEX "QuoteItem_shopifyProductGid_idx" ON "QuoteItem"("shopifyProductGid");

-- CreateIndex
CREATE INDEX "QuoteItem_shopifyVariantGid_idx" ON "QuoteItem"("shopifyVariantGid");

-- CreateIndex
CREATE INDEX "ProductCost_shop_idx" ON "ProductCost"("shop");

-- CreateIndex
CREATE INDEX "ProductCost_variantId_idx" ON "ProductCost"("variantId");

-- CreateIndex
CREATE INDEX "ProductCost_sku_idx" ON "ProductCost"("sku");

-- CreateIndex
CREATE INDEX "ProductCost_productName_idx" ON "ProductCost"("productName");

-- CreateIndex
CREATE INDEX "ProductCategory_shop_idx" ON "ProductCategory"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_shop_slug_key" ON "ProductCategory"("shop", "slug");

-- CreateIndex
CREATE INDEX "Material_shop_idx" ON "Material"("shop");

-- CreateIndex
CREATE INDEX "Material_shop_materialType_idx" ON "Material"("shop", "materialType");

-- CreateIndex
CREATE INDEX "Material_shop_productFamilies_idx" ON "Material"("shop", "productFamilies");

-- CreateIndex
CREATE INDEX "Material_shop_active_idx" ON "Material"("shop", "active");

-- CreateIndex
CREATE INDEX "Material_shop_costReviewNeeded_idx" ON "Material"("shop", "costReviewNeeded");

-- CreateIndex
CREATE INDEX "Material_shop_useInRecipes_idx" ON "Material"("shop", "useInRecipes");

-- CreateIndex
CREATE INDEX "Material_primaryVendorId_idx" ON "Material"("primaryVendorId");

-- CreateIndex
CREATE INDEX "MaterialVariant_shop_idx" ON "MaterialVariant"("shop");

-- CreateIndex
CREATE INDEX "MaterialVariant_materialId_idx" ON "MaterialVariant"("materialId");

-- CreateIndex
CREATE INDEX "MaterialVariant_shop_active_idx" ON "MaterialVariant"("shop", "active");

-- CreateIndex
CREATE INDEX "ProductTypeProfile_shop_idx" ON "ProductTypeProfile"("shop");

-- CreateIndex
CREATE INDEX "ProductTypeProfile_shop_active_idx" ON "ProductTypeProfile"("shop", "active");

-- CreateIndex
CREATE INDEX "ProductTypeProfile_key_idx" ON "ProductTypeProfile"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ProductTypeProfile_shop_key_key" ON "ProductTypeProfile"("shop", "key");

-- CreateIndex
CREATE INDEX "ProductRecipe_shop_idx" ON "ProductRecipe"("shop");

-- CreateIndex
CREATE INDEX "ProductRecipe_shop_productType_idx" ON "ProductRecipe"("shop", "productType");

-- CreateIndex
CREATE INDEX "ProductRecipe_productTypeProfileId_idx" ON "ProductRecipe"("productTypeProfileId");

-- CreateIndex
CREATE INDEX "ProductRecipe_shop_productionMode_idx" ON "ProductRecipe"("shop", "productionMode");

-- CreateIndex
CREATE INDEX "ProductRecipe_shop_sku_idx" ON "ProductRecipe"("shop", "sku");

-- CreateIndex
CREATE INDEX "ProductRecipe_shop_productGid_idx" ON "ProductRecipe"("shop", "productGid");

-- CreateIndex
CREATE INDEX "ProductRecipe_shop_variantGid_idx" ON "ProductRecipe"("shop", "variantGid");

-- CreateIndex
CREATE INDEX "ProductRecipe_shop_shopifyTargetMode_idx" ON "ProductRecipe"("shop", "shopifyTargetMode");

-- CreateIndex
CREATE INDEX "ProductRecipe_shop_active_idx" ON "ProductRecipe"("shop", "active");

-- CreateIndex
CREATE INDEX "ProductRecipe_vendorProductId_idx" ON "ProductRecipe"("vendorProductId");

-- CreateIndex
CREATE INDEX "VendorProduct_shop_idx" ON "VendorProduct"("shop");

-- CreateIndex
CREATE INDEX "VendorProduct_shop_active_idx" ON "VendorProduct"("shop", "active");

-- CreateIndex
CREATE INDEX "VendorProduct_productType_idx" ON "VendorProduct"("productType");

-- CreateIndex
CREATE INDEX "VendorProduct_vendor_idx" ON "VendorProduct"("vendor");

-- CreateIndex
CREATE INDEX "VendorProduct_vendorId_idx" ON "VendorProduct"("vendorId");

-- CreateIndex
CREATE INDEX "VendorProductTier_shop_idx" ON "VendorProductTier"("shop");

-- CreateIndex
CREATE INDEX "VendorProductTier_vendorProductId_idx" ON "VendorProductTier"("vendorProductId");

-- CreateIndex
CREATE INDEX "VendorProductTier_minQty_idx" ON "VendorProductTier"("minQty");

-- CreateIndex
CREATE INDEX "VendorProductAddOn_shop_idx" ON "VendorProductAddOn"("shop");

-- CreateIndex
CREATE INDEX "VendorProductAddOn_vendorProductId_idx" ON "VendorProductAddOn"("vendorProductId");

-- CreateIndex
CREATE INDEX "VendorProductAddOn_pricingType_idx" ON "VendorProductAddOn"("pricingType");

-- CreateIndex
CREATE INDEX "RecipeVariantRule_shop_idx" ON "RecipeVariantRule"("shop");

-- CreateIndex
CREATE INDEX "RecipeVariantRule_recipeId_idx" ON "RecipeVariantRule"("recipeId");

-- CreateIndex
CREATE INDEX "RecipeVariantRule_shop_active_idx" ON "RecipeVariantRule"("shop", "active");

-- CreateIndex
CREATE INDEX "RecipeVariantRule_shop_shopifyProductGid_idx" ON "RecipeVariantRule"("shop", "shopifyProductGid");

-- CreateIndex
CREATE INDEX "RecipeVariantRule_shop_shopifyVariantGid_idx" ON "RecipeVariantRule"("shop", "shopifyVariantGid");

-- CreateIndex
CREATE INDEX "RecipeVariantRule_sku_idx" ON "RecipeVariantRule"("sku");

-- CreateIndex
CREATE INDEX "RecipeMediaOption_shop_idx" ON "RecipeMediaOption"("shop");

-- CreateIndex
CREATE INDEX "RecipeMediaOption_recipeId_idx" ON "RecipeMediaOption"("recipeId");

-- CreateIndex
CREATE INDEX "RecipeMediaOption_materialId_idx" ON "RecipeMediaOption"("materialId");

-- CreateIndex
CREATE INDEX "RecipeMediaOption_shop_active_idx" ON "RecipeMediaOption"("shop", "active");

-- CreateIndex
CREATE INDEX "RecipeLabelZone_shop_idx" ON "RecipeLabelZone"("shop");

-- CreateIndex
CREATE INDEX "RecipeLabelZone_recipeId_idx" ON "RecipeLabelZone"("recipeId");

-- CreateIndex
CREATE INDEX "RecipeLabelZone_materialId_idx" ON "RecipeLabelZone"("materialId");

-- CreateIndex
CREATE INDEX "RecipeLabelZone_mediaOptionId_idx" ON "RecipeLabelZone"("mediaOptionId");

-- CreateIndex
CREATE INDEX "RecipeLabelZone_shop_active_idx" ON "RecipeLabelZone"("shop", "active");

-- CreateIndex
CREATE INDEX "RecipeMaterial_shop_idx" ON "RecipeMaterial"("shop");

-- CreateIndex
CREATE INDEX "RecipeMaterial_recipeId_idx" ON "RecipeMaterial"("recipeId");

-- CreateIndex
CREATE INDEX "RecipeMaterial_materialId_idx" ON "RecipeMaterial"("materialId");

-- CreateIndex
CREATE INDEX "RecipeMaterial_usageType_idx" ON "RecipeMaterial"("usageType");

-- CreateIndex
CREATE INDEX "RecipeMaterial_shop_active_idx" ON "RecipeMaterial"("shop", "active");

-- CreateIndex
CREATE INDEX "RecipeInkRequirement_shop_idx" ON "RecipeInkRequirement"("shop");

-- CreateIndex
CREATE INDEX "RecipeInkRequirement_recipeId_idx" ON "RecipeInkRequirement"("recipeId");

-- CreateIndex
CREATE INDEX "RecipeInkRequirement_inkType_idx" ON "RecipeInkRequirement"("inkType");

-- CreateIndex
CREATE INDEX "RecipeMachineRule_shop_idx" ON "RecipeMachineRule"("shop");

-- CreateIndex
CREATE INDEX "RecipeMachineRule_recipeId_idx" ON "RecipeMachineRule"("recipeId");

-- CreateIndex
CREATE INDEX "RecipeMachineRule_preferredMachineId_idx" ON "RecipeMachineRule"("preferredMachineId");

-- CreateIndex
CREATE INDEX "RecipeTier_shop_idx" ON "RecipeTier"("shop");

-- CreateIndex
CREATE INDEX "RecipeTier_recipeId_idx" ON "RecipeTier"("recipeId");

-- CreateIndex
CREATE INDEX "RecipeTier_minQty_idx" ON "RecipeTier"("minQty");

-- CreateIndex
CREATE INDEX "RecipeAddOn_shop_idx" ON "RecipeAddOn"("shop");

-- CreateIndex
CREATE INDEX "RecipeAddOn_recipeId_idx" ON "RecipeAddOn"("recipeId");

-- CreateIndex
CREATE INDEX "RecipeAddOn_pricingType_idx" ON "RecipeAddOn"("pricingType");

-- CreateIndex
CREATE INDEX "SourcedCostTier_shop_idx" ON "SourcedCostTier"("shop");

-- CreateIndex
CREATE INDEX "SourcedCostTier_recipeId_idx" ON "SourcedCostTier"("recipeId");

-- CreateIndex
CREATE INDEX "SourcedCostTier_minQty_idx" ON "SourcedCostTier"("minQty");

-- CreateIndex
CREATE INDEX "MaterialCostHistory_shop_idx" ON "MaterialCostHistory"("shop");

-- CreateIndex
CREATE INDEX "MaterialCostHistory_materialId_idx" ON "MaterialCostHistory"("materialId");

-- CreateIndex
CREATE INDEX "MaterialVendor_shop_idx" ON "MaterialVendor"("shop");

-- CreateIndex
CREATE INDEX "MaterialVendor_materialId_idx" ON "MaterialVendor"("materialId");

-- CreateIndex
CREATE INDEX "MaterialVendor_shop_active_idx" ON "MaterialVendor"("shop", "active");

-- CreateIndex
CREATE INDEX "Machine_shop_idx" ON "Machine"("shop");

-- CreateIndex
CREATE INDEX "Machine_shop_active_idx" ON "Machine"("shop", "active");

-- CreateIndex
CREATE INDEX "MachineInkChannel_shop_idx" ON "MachineInkChannel"("shop");

-- CreateIndex
CREATE INDEX "MachineInkChannel_machineId_idx" ON "MachineInkChannel"("machineId");

-- CreateIndex
CREATE INDEX "MachineInkChannel_inkType_idx" ON "MachineInkChannel"("inkType");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionJob_proofApprovalToken_key" ON "ProductionJob"("proofApprovalToken");

-- CreateIndex
CREATE INDEX "ProductionJob_shop_idx" ON "ProductionJob"("shop");

-- CreateIndex
CREATE INDEX "ProductionJob_shop_status_idx" ON "ProductionJob"("shop", "status");

-- CreateIndex
CREATE INDEX "ProductionJob_shop_priority_idx" ON "ProductionJob"("shop", "priority");

-- CreateIndex
CREATE INDEX "ProductionJob_quoteId_idx" ON "ProductionJob"("quoteId");

-- CreateIndex
CREATE INDEX "ProductionJob_jobTicket_idx" ON "ProductionJob"("jobTicket");

-- CreateIndex
CREATE INDEX "ProductionJob_proofApprovalToken_idx" ON "ProductionJob"("proofApprovalToken");

-- CreateIndex
CREATE INDEX "ProductionJob_proofStatus_idx" ON "ProductionJob"("proofStatus");

-- CreateIndex
CREATE INDEX "ProductionJob_assetInboxKey_idx" ON "ProductionJob"("assetInboxKey");

-- CreateIndex
CREATE INDEX "ProductionJob_dueDate_idx" ON "ProductionJob"("dueDate");

-- CreateIndex
CREATE INDEX "ProductionJobItem_shop_idx" ON "ProductionJobItem"("shop");

-- CreateIndex
CREATE INDEX "ProductionJobItem_jobId_idx" ON "ProductionJobItem"("jobId");

-- CreateIndex
CREATE INDEX "ProductionJobItem_quoteItemId_idx" ON "ProductionJobItem"("quoteItemId");

-- CreateIndex
CREATE INDEX "ProductionJobItem_itemTicket_idx" ON "ProductionJobItem"("itemTicket");

-- CreateIndex
CREATE INDEX "ProductionJobItem_ripJobName_idx" ON "ProductionJobItem"("ripJobName");

-- CreateIndex
CREATE INDEX "ProductionJobItem_sku_idx" ON "ProductionJobItem"("sku");

-- CreateIndex
CREATE INDEX "ProductionJobItem_recipeId_idx" ON "ProductionJobItem"("recipeId");

-- CreateIndex
CREATE INDEX "ProductionJobFile_shop_idx" ON "ProductionJobFile"("shop");

-- CreateIndex
CREATE INDEX "ProductionJobFile_jobId_idx" ON "ProductionJobFile"("jobId");

-- CreateIndex
CREATE INDEX "ProductionJobFile_fileType_idx" ON "ProductionJobFile"("fileType");

-- CreateIndex
CREATE INDEX "ProductionJobFile_assetRole_idx" ON "ProductionJobFile"("assetRole");

-- CreateIndex
CREATE INDEX "ProductionJobFile_assetSource_idx" ON "ProductionJobFile"("assetSource");

-- CreateIndex
CREATE INDEX "ProductionJobFile_jobTicket_idx" ON "ProductionJobFile"("jobTicket");

-- CreateIndex
CREATE INDEX "ProductionJobFile_sourceRef_idx" ON "ProductionJobFile"("sourceRef");

-- CreateIndex
CREATE INDEX "ProductionJobEvent_shop_idx" ON "ProductionJobEvent"("shop");

-- CreateIndex
CREATE INDEX "ProductionJobEvent_jobId_idx" ON "ProductionJobEvent"("jobId");

-- CreateIndex
CREATE INDEX "ProductionJobEvent_eventType_idx" ON "ProductionJobEvent"("eventType");

-- CreateIndex
CREATE INDEX "ProductionJobEvent_createdAt_idx" ON "ProductionJobEvent"("createdAt");

-- CreateIndex
CREATE INDEX "ProductionChecklistItem_shop_idx" ON "ProductionChecklistItem"("shop");

-- CreateIndex
CREATE INDEX "ProductionChecklistItem_jobId_idx" ON "ProductionChecklistItem"("jobId");

-- CreateIndex
CREATE INDEX "ProductionChecklistItem_section_idx" ON "ProductionChecklistItem"("section");

-- CreateIndex
CREATE INDEX "ProductionChecklistItem_completed_idx" ON "ProductionChecklistItem"("completed");

-- CreateIndex
CREATE INDEX "ProductionMaterialUsage_shop_idx" ON "ProductionMaterialUsage"("shop");

-- CreateIndex
CREATE INDEX "ProductionMaterialUsage_jobId_idx" ON "ProductionMaterialUsage"("jobId");

-- CreateIndex
CREATE INDEX "ProductionMaterialUsage_materialId_idx" ON "ProductionMaterialUsage"("materialId");

-- CreateIndex
CREATE INDEX "ProductionMaterialUsage_materialType_idx" ON "ProductionMaterialUsage"("materialType");

-- CreateIndex
CREATE INDEX "ProductionMaterialUsage_source_idx" ON "ProductionMaterialUsage"("source");

-- CreateIndex
CREATE INDEX "MaterialInventoryMovement_shop_idx" ON "MaterialInventoryMovement"("shop");

-- CreateIndex
CREATE INDEX "MaterialInventoryMovement_materialId_idx" ON "MaterialInventoryMovement"("materialId");

-- CreateIndex
CREATE INDEX "MaterialInventoryMovement_jobId_idx" ON "MaterialInventoryMovement"("jobId");

-- CreateIndex
CREATE INDEX "MaterialInventoryMovement_materialUsageId_idx" ON "MaterialInventoryMovement"("materialUsageId");

-- CreateIndex
CREATE INDEX "MaterialInventoryMovement_movementType_idx" ON "MaterialInventoryMovement"("movementType");

-- CreateIndex
CREATE INDEX "MaterialInventoryMovement_createdAt_idx" ON "MaterialInventoryMovement"("createdAt");

-- CreateIndex
CREATE INDEX "PrintLogImport_shop_idx" ON "PrintLogImport"("shop");

-- CreateIndex
CREATE INDEX "PrintLogImport_source_idx" ON "PrintLogImport"("source");

-- CreateIndex
CREATE INDEX "PrintLogImport_createdAt_idx" ON "PrintLogImport"("createdAt");

-- CreateIndex
CREATE INDEX "PrintLogEntry_shop_idx" ON "PrintLogEntry"("shop");

-- CreateIndex
CREATE INDEX "PrintLogEntry_importId_idx" ON "PrintLogEntry"("importId");

-- CreateIndex
CREATE INDEX "PrintLogEntry_productionJobId_idx" ON "PrintLogEntry"("productionJobId");

-- CreateIndex
CREATE INDEX "PrintLogEntry_productionJobItemId_idx" ON "PrintLogEntry"("productionJobItemId");

-- CreateIndex
CREATE INDEX "PrintLogEntry_jobTicket_idx" ON "PrintLogEntry"("jobTicket");

-- CreateIndex
CREATE INDEX "PrintLogEntry_sourceJobName_idx" ON "PrintLogEntry"("sourceJobName");

-- CreateIndex
CREATE INDEX "PrintLogEntry_createdAt_idx" ON "PrintLogEntry"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PrintLogAutoImportSetting_shop_key" ON "PrintLogAutoImportSetting"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "PrintLogAutoImportSetting_uploadToken_key" ON "PrintLogAutoImportSetting"("uploadToken");

-- CreateIndex
CREATE INDEX "PrintLogAutoImportSetting_enabled_idx" ON "PrintLogAutoImportSetting"("enabled");

-- CreateIndex
CREATE INDEX "PrintLogAutoImportSetting_lastAutoImportAt_idx" ON "PrintLogAutoImportSetting"("lastAutoImportAt");

-- CreateIndex
CREATE INDEX "PurchaseRequest_shop_idx" ON "PurchaseRequest"("shop");

-- CreateIndex
CREATE INDEX "PurchaseRequest_shop_status_idx" ON "PurchaseRequest"("shop", "status");

-- CreateIndex
CREATE INDEX "PurchaseRequest_materialId_idx" ON "PurchaseRequest"("materialId");

-- CreateIndex
CREATE INDEX "PurchaseRequest_vendor_idx" ON "PurchaseRequest"("vendor");

-- CreateIndex
CREATE INDEX "PurchaseRequest_vendorId_idx" ON "PurchaseRequest"("vendorId");

-- CreateIndex
CREATE INDEX "PurchaseRequest_neededBy_idx" ON "PurchaseRequest"("neededBy");

-- CreateIndex
CREATE INDEX "PurchaseRequest_sentAt_idx" ON "PurchaseRequest"("sentAt");

-- CreateIndex
CREATE INDEX "PurchaseRequest_expectedArrivalDate_idx" ON "PurchaseRequest"("expectedArrivalDate");

-- CreateIndex
CREATE INDEX "PurchaseRequest_followUpNeeded_idx" ON "PurchaseRequest"("followUpNeeded");

-- CreateIndex
CREATE INDEX "PurchaseRequest_createdAt_idx" ON "PurchaseRequest"("createdAt");

-- CreateIndex
CREATE INDEX "Vendor_shop_idx" ON "Vendor"("shop");

-- CreateIndex
CREATE INDEX "Vendor_shop_active_idx" ON "Vendor"("shop", "active");

-- CreateIndex
CREATE INDEX "Vendor_vendorType_idx" ON "Vendor"("vendorType");

-- CreateIndex
CREATE INDEX "Vendor_status_idx" ON "Vendor"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_shop_name_key" ON "Vendor"("shop", "name");

-- CreateIndex
CREATE INDEX "VendorContact_shop_idx" ON "VendorContact"("shop");

-- CreateIndex
CREATE INDEX "VendorContact_vendorId_idx" ON "VendorContact"("vendorId");

-- CreateIndex
CREATE INDEX "VendorContact_primary_idx" ON "VendorContact"("primary");

-- CreateIndex
CREATE INDEX "VendorContact_active_idx" ON "VendorContact"("active");

-- CreateIndex
CREATE INDEX "VendorCostBookItem_shop_idx" ON "VendorCostBookItem"("shop");

-- CreateIndex
CREATE INDEX "VendorCostBookItem_vendorId_idx" ON "VendorCostBookItem"("vendorId");

-- CreateIndex
CREATE INDEX "VendorCostBookItem_vendorName_idx" ON "VendorCostBookItem"("vendorName");

-- CreateIndex
CREATE INDEX "VendorCostBookItem_itemType_idx" ON "VendorCostBookItem"("itemType");

-- CreateIndex
CREATE INDEX "VendorCostBookItem_materialId_idx" ON "VendorCostBookItem"("materialId");

-- CreateIndex
CREATE INDEX "VendorCostBookItem_vendorProductId_idx" ON "VendorCostBookItem"("vendorProductId");

-- CreateIndex
CREATE INDEX "VendorCostBookItem_status_idx" ON "VendorCostBookItem"("status");

-- CreateIndex
CREATE INDEX "VendorCostBookItem_preferred_idx" ON "VendorCostBookItem"("preferred");

-- CreateIndex
CREATE INDEX "VendorCostBookItem_effectiveDate_idx" ON "VendorCostBookItem"("effectiveDate");

-- CreateIndex
CREATE INDEX "VendorCostBookTier_shop_idx" ON "VendorCostBookTier"("shop");

-- CreateIndex
CREATE INDEX "VendorCostBookTier_vendorCostBookItemId_idx" ON "VendorCostBookTier"("vendorCostBookItemId");

-- CreateIndex
CREATE INDEX "VendorCostBookTier_minQty_idx" ON "VendorCostBookTier"("minQty");

-- CreateIndex
CREATE INDEX "ErpAdminSetting_shop_idx" ON "ErpAdminSetting"("shop");

-- CreateIndex
CREATE INDEX "ErpAdminSetting_category_idx" ON "ErpAdminSetting"("category");

-- CreateIndex
CREATE INDEX "ErpAdminSetting_key_idx" ON "ErpAdminSetting"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ErpAdminSetting_shop_key_key" ON "ErpAdminSetting"("shop", "key");

-- CreateIndex
CREATE INDEX "PriceApprovalRecord_shop_idx" ON "PriceApprovalRecord"("shop");

-- CreateIndex
CREATE INDEX "PriceApprovalRecord_shop_status_idx" ON "PriceApprovalRecord"("shop", "status");

-- CreateIndex
CREATE INDEX "PriceApprovalRecord_shop_recipeId_idx" ON "PriceApprovalRecord"("shop", "recipeId");

-- CreateIndex
CREATE INDEX "PriceApprovalRecord_shop_shopifyVariantGid_idx" ON "PriceApprovalRecord"("shop", "shopifyVariantGid");

-- CreateIndex
CREATE UNIQUE INDEX "PriceApprovalRecord_shop_variantRuleId_key" ON "PriceApprovalRecord"("shop", "variantRuleId");

-- CreateIndex
CREATE INDEX "AgentReviewQueueItem_shop_idx" ON "AgentReviewQueueItem"("shop");

-- CreateIndex
CREATE INDEX "AgentReviewQueueItem_shop_status_idx" ON "AgentReviewQueueItem"("shop", "status");

-- CreateIndex
CREATE INDEX "AgentReviewQueueItem_shop_reviewLevel_idx" ON "AgentReviewQueueItem"("shop", "reviewLevel");

-- CreateIndex
CREATE INDEX "AgentReviewQueueItem_shop_source_idx" ON "AgentReviewQueueItem"("shop", "source");

-- CreateIndex
CREATE INDEX "AgentReviewQueueItem_shop_assignedStaffId_idx" ON "AgentReviewQueueItem"("shop", "assignedStaffId");

-- CreateIndex
CREATE INDEX "AgentReviewQueueItem_shop_assignedStaffEmail_idx" ON "AgentReviewQueueItem"("shop", "assignedStaffEmail");

-- CreateIndex
CREATE INDEX "AgentReviewQueueItem_shop_createdAt_idx" ON "AgentReviewQueueItem"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "AgentReviewQueueItem_shop_updatedAt_idx" ON "AgentReviewQueueItem"("shop", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentReviewQueueItem_convertedQuoteId_idx" ON "AgentReviewQueueItem"("convertedQuoteId");

-- CreateIndex
CREATE INDEX "AgentReviewQueueEvent_shop_idx" ON "AgentReviewQueueEvent"("shop");

-- CreateIndex
CREATE INDEX "AgentReviewQueueEvent_queueItemId_idx" ON "AgentReviewQueueEvent"("queueItemId");

-- CreateIndex
CREATE INDEX "AgentReviewQueueEvent_shop_eventType_idx" ON "AgentReviewQueueEvent"("shop", "eventType");

-- CreateIndex
CREATE INDEX "AgentReviewQueueEvent_actorType_idx" ON "AgentReviewQueueEvent"("actorType");

-- CreateIndex
CREATE INDEX "AgentReviewQueueEvent_actorEmail_idx" ON "AgentReviewQueueEvent"("actorEmail");

-- CreateIndex
CREATE INDEX "AgentReviewQueueEvent_createdAt_idx" ON "AgentReviewQueueEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AgentApiCredential_shop_idx" ON "AgentApiCredential"("shop");

-- CreateIndex
CREATE INDEX "AgentApiCredential_shop_isActive_idx" ON "AgentApiCredential"("shop", "isActive");

-- CreateIndex
CREATE INDEX "AgentApiCredential_shop_agentId_idx" ON "AgentApiCredential"("shop", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentApiCredential_shop_tokenId_key" ON "AgentApiCredential"("shop", "tokenId");

-- CreateIndex
CREATE INDEX "AgentSubmissionLog_shop_idx" ON "AgentSubmissionLog"("shop");

-- CreateIndex
CREATE INDEX "AgentSubmissionLog_credentialId_idx" ON "AgentSubmissionLog"("credentialId");

-- CreateIndex
CREATE INDEX "AgentSubmissionLog_shop_createdAt_idx" ON "AgentSubmissionLog"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "AgentSubmissionLog_shop_sourceChannel_externalLeadId_idx" ON "AgentSubmissionLog"("shop", "sourceChannel", "externalLeadId");

-- CreateIndex
CREATE INDEX "AgentSubmissionLog_shop_idempotencyKey_idx" ON "AgentSubmissionLog"("shop", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentSubmissionLog_status_createdAt_idx" ON "AgentSubmissionLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MarginReviewSetting_shop_idx" ON "MarginReviewSetting"("shop");

-- CreateIndex
CREATE INDEX "ConfiguratorProduct_shop_productType_idx" ON "ConfiguratorProduct"("shop", "productType");

-- CreateIndex
CREATE INDEX "ConfiguratorProduct_shop_active_idx" ON "ConfiguratorProduct"("shop", "active");

-- CreateIndex
CREATE INDEX "ConfiguratorProduct_shop_pilot_idx" ON "ConfiguratorProduct"("shop", "pilot");

-- CreateIndex
CREATE INDEX "ConfiguratorProduct_shopifyProductGid_idx" ON "ConfiguratorProduct"("shopifyProductGid");

-- CreateIndex
CREATE INDEX "ConfiguratorProduct_shopifyVariantGid_idx" ON "ConfiguratorProduct"("shopifyVariantGid");

-- CreateIndex
CREATE UNIQUE INDEX "ConfiguratorProduct_shop_title_key" ON "ConfiguratorProduct"("shop", "title");

-- CreateIndex
CREATE INDEX "ConfiguratorOption_shop_productType_group_idx" ON "ConfiguratorOption"("shop", "productType", "group");

-- CreateIndex
CREATE INDEX "ConfiguratorOption_shop_active_idx" ON "ConfiguratorOption"("shop", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ConfiguratorOption_shop_productType_group_value_key" ON "ConfiguratorOption"("shop", "productType", "group", "value");

-- CreateIndex
CREATE INDEX "ConfiguratorPricingRule_shop_productType_idx" ON "ConfiguratorPricingRule"("shop", "productType");

-- CreateIndex
CREATE INDEX "ConfiguratorPricingRule_shop_active_idx" ON "ConfiguratorPricingRule"("shop", "active");

-- CreateIndex
CREATE INDEX "ConfiguratorPricingRule_shop_material_finish_idx" ON "ConfiguratorPricingRule"("shop", "material", "finish");

-- CreateIndex
CREATE INDEX "ConfiguratorPricingRule_shop_minQty_maxQty_idx" ON "ConfiguratorPricingRule"("shop", "minQty", "maxQty");

-- CreateIndex
CREATE UNIQUE INDEX "ConfiguratorPricingRule_shop_productType_material_finish_si_key" ON "ConfiguratorPricingRule"("shop", "productType", "material", "finish", "sides", "minQty", "maxQty");

-- AddForeignKey
ALTER TABLE "WholesaleRule" ADD CONSTRAINT "WholesaleRule_settingsId_fkey" FOREIGN KEY ("settingsId") REFERENCES "ShopSettings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WholesaleApplication" ADD CONSTRAINT "WholesaleApplication_settingsId_fkey" FOREIGN KEY ("settingsId") REFERENCES "ShopSettings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_primaryVendorId_fkey" FOREIGN KEY ("primaryVendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialVariant" ADD CONSTRAINT "MaterialVariant_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductRecipe" ADD CONSTRAINT "ProductRecipe_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductRecipe" ADD CONSTRAINT "ProductRecipe_productTypeProfileId_fkey" FOREIGN KEY ("productTypeProfileId") REFERENCES "ProductTypeProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductRecipe" ADD CONSTRAINT "ProductRecipe_vendorProductId_fkey" FOREIGN KEY ("vendorProductId") REFERENCES "VendorProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorProduct" ADD CONSTRAINT "VendorProduct_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorProductTier" ADD CONSTRAINT "VendorProductTier_vendorProductId_fkey" FOREIGN KEY ("vendorProductId") REFERENCES "VendorProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorProductAddOn" ADD CONSTRAINT "VendorProductAddOn_vendorProductId_fkey" FOREIGN KEY ("vendorProductId") REFERENCES "VendorProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeVariantRule" ADD CONSTRAINT "RecipeVariantRule_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "ProductRecipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeMediaOption" ADD CONSTRAINT "RecipeMediaOption_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "ProductRecipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeMediaOption" ADD CONSTRAINT "RecipeMediaOption_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeLabelZone" ADD CONSTRAINT "RecipeLabelZone_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "ProductRecipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeLabelZone" ADD CONSTRAINT "RecipeLabelZone_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeLabelZone" ADD CONSTRAINT "RecipeLabelZone_mediaOptionId_fkey" FOREIGN KEY ("mediaOptionId") REFERENCES "RecipeMediaOption"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeMaterial" ADD CONSTRAINT "RecipeMaterial_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "ProductRecipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeMaterial" ADD CONSTRAINT "RecipeMaterial_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeInkRequirement" ADD CONSTRAINT "RecipeInkRequirement_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "ProductRecipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeMachineRule" ADD CONSTRAINT "RecipeMachineRule_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "ProductRecipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeMachineRule" ADD CONSTRAINT "RecipeMachineRule_preferredMachineId_fkey" FOREIGN KEY ("preferredMachineId") REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeTier" ADD CONSTRAINT "RecipeTier_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "ProductRecipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeAddOn" ADD CONSTRAINT "RecipeAddOn_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "ProductRecipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourcedCostTier" ADD CONSTRAINT "SourcedCostTier_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "ProductRecipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialCostHistory" ADD CONSTRAINT "MaterialCostHistory_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialVendor" ADD CONSTRAINT "MaterialVendor_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineInkChannel" ADD CONSTRAINT "MachineInkChannel_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionJobItem" ADD CONSTRAINT "ProductionJobItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProductionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionJobFile" ADD CONSTRAINT "ProductionJobFile_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProductionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionJobEvent" ADD CONSTRAINT "ProductionJobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProductionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionChecklistItem" ADD CONSTRAINT "ProductionChecklistItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProductionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionMaterialUsage" ADD CONSTRAINT "ProductionMaterialUsage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProductionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionMaterialUsage" ADD CONSTRAINT "ProductionMaterialUsage_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialInventoryMovement" ADD CONSTRAINT "MaterialInventoryMovement_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialInventoryMovement" ADD CONSTRAINT "MaterialInventoryMovement_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProductionJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintLogEntry" ADD CONSTRAINT "PrintLogEntry_importId_fkey" FOREIGN KEY ("importId") REFERENCES "PrintLogImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorContact" ADD CONSTRAINT "VendorContact_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorCostBookTier" ADD CONSTRAINT "VendorCostBookTier_vendorCostBookItemId_fkey" FOREIGN KEY ("vendorCostBookItemId") REFERENCES "VendorCostBookItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentReviewQueueEvent" ADD CONSTRAINT "AgentReviewQueueEvent_queueItemId_fkey" FOREIGN KEY ("queueItemId") REFERENCES "AgentReviewQueueItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

