from django.contrib import admin

from .models import CatalogItem


@admin.register(CatalogItem)
class CatalogItemAdmin(admin.ModelAdmin):
    list_display = (
        "internal_sku",
        "title",
        "kind",
        "condition",
        "completeness",
        "sealed",
        "active",
        "created_at",
    )
    list_filter = ("kind", "condition", "completeness", "sealed", "active")
    search_fields = ("internal_sku", "title", "bricklink_item_number")
    readonly_fields = ("id", "created_at", "updated_at")

