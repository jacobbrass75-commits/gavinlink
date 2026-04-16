from django.contrib import admin

from .models import Purchase, PurchaseLine


class PurchaseLineInline(admin.TabularInline):
    model = PurchaseLine
    extra = 0
    readonly_fields = ("id", "created_at", "updated_at")


@admin.register(Purchase)
class PurchaseAdmin(admin.ModelAdmin):
    list_display = (
        "source_name",
        "source_reference",
        "status",
        "purchased_at",
        "merchandise_cost",
        "shipping_cost",
        "fees_cost",
        "landed_cost",
    )
    list_filter = ("status", "source_name", "purchased_at")
    search_fields = ("source_name", "source_reference", "notes")
    readonly_fields = ("id", "created_at", "updated_at")
    inlines = [PurchaseLineInline]


@admin.register(PurchaseLine)
class PurchaseLineAdmin(admin.ModelAdmin):
    list_display = ("purchase", "item", "quantity", "unit_cost", "line_total_cost", "created_at")
    list_filter = ("purchase__status",)
    search_fields = ("purchase__source_name", "purchase__source_reference", "item__internal_sku")
    readonly_fields = ("id", "created_at", "updated_at")

