-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShopSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "wholesaleTag" TEXT NOT NULL DEFAULT 'wholesale_approved',
    "pendingTag" TEXT NOT NULL DEFAULT 'wholesale_pending',
    "vipTag" TEXT NOT NULL DEFAULT 'vip_wholesale',
    "applicationMode" TEXT NOT NULL DEFAULT 'manual',
    "storewidePercentOff" REAL NOT NULL DEFAULT 0,
    "minimumSubtotal" REAL NOT NULL DEFAULT 0,
    "minCartQuantity" INTEGER NOT NULL DEFAULT 1,
    "enforceMinCartQty" BOOLEAN NOT NULL DEFAULT false,
    "lockWholesaleAccess" BOOLEAN NOT NULL DEFAULT false,
    "autoCreateDiscount" BOOLEAN NOT NULL DEFAULT false,
    "wholesaleDiscountId" TEXT,
    "validationOwnerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ShopSettings" ("applicationMode", "autoCreateDiscount", "createdAt", "id", "lockWholesaleAccess", "minimumSubtotal", "pendingTag", "shop", "storewidePercentOff", "updatedAt", "validationOwnerId", "wholesaleDiscountId", "wholesaleTag") SELECT "applicationMode", "autoCreateDiscount", "createdAt", "id", "lockWholesaleAccess", "minimumSubtotal", "pendingTag", "shop", "storewidePercentOff", "updatedAt", "validationOwnerId", "wholesaleDiscountId", "wholesaleTag" FROM "ShopSettings";
DROP TABLE "ShopSettings";
ALTER TABLE "new_ShopSettings" RENAME TO "ShopSettings";
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");
CREATE TABLE "new_WholesaleRule" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "customerTag" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT,
    "scopeLabel" TEXT,
    "discountType" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "minQuantity" INTEGER NOT NULL DEFAULT 1,
    "minProductQuantity" INTEGER,
    "minCartQuantity" INTEGER,
    "minSubtotal" REAL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "settingsId" INTEGER,
    CONSTRAINT "WholesaleRule_settingsId_fkey" FOREIGN KEY ("settingsId") REFERENCES "ShopSettings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WholesaleRule" ("createdAt", "customerTag", "discountType", "id", "minQuantity", "priority", "scopeId", "scopeLabel", "scopeType", "settingsId", "shop", "title", "updatedAt", "value") SELECT "createdAt", "customerTag", "discountType", "id", "minQuantity", "priority", "scopeId", "scopeLabel", "scopeType", "settingsId", "shop", "title", "updatedAt", "value" FROM "WholesaleRule";
DROP TABLE "WholesaleRule";
ALTER TABLE "new_WholesaleRule" RENAME TO "WholesaleRule";
CREATE INDEX "WholesaleRule_shop_active_idx" ON "WholesaleRule"("shop", "active");
CREATE INDEX "WholesaleRule_shop_customerTag_idx" ON "WholesaleRule"("shop", "customerTag");
CREATE INDEX "WholesaleRule_shop_scopeType_scopeId_idx" ON "WholesaleRule"("shop", "scopeType", "scopeId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "WholesaleApplication_shop_status_idx" ON "WholesaleApplication"("shop", "status");
