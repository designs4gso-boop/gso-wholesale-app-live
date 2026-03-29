-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" DATETIME,
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "wholesaleTag" TEXT NOT NULL DEFAULT 'wholesale_approved',
    "pendingTag" TEXT NOT NULL DEFAULT 'wholesale_pending',
    "applicationMode" TEXT NOT NULL DEFAULT 'manual',
    "storewidePercentOff" REAL NOT NULL DEFAULT 20,
    "minimumSubtotal" REAL NOT NULL DEFAULT 0,
    "lockWholesaleAccess" BOOLEAN NOT NULL DEFAULT false,
    "autoCreateDiscount" BOOLEAN NOT NULL DEFAULT true,
    "wholesaleDiscountId" TEXT,
    "validationOwnerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WholesaleRule" (
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
    "priority" INTEGER NOT NULL DEFAULT 100,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "settingsId" INTEGER,
    CONSTRAINT "WholesaleRule_settingsId_fkey" FOREIGN KEY ("settingsId") REFERENCES "ShopSettings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WholesaleApplication" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "companyName" TEXT,
    "phone" TEXT,
    "taxId" TEXT,
    "resaleNumber" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "settingsId" INTEGER,
    CONSTRAINT "WholesaleApplication_settingsId_fkey" FOREIGN KEY ("settingsId") REFERENCES "ShopSettings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");
