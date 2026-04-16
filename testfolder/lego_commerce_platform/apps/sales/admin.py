from django.contrib import admin

from .models import SaleRecord


@admin.register(SaleRecord)
class SaleRecordAdmin(admin.ModelAdmin):
    list_display = (
        "external_order_id",
        "channel",
        "status",
        "currency",
        "subtotal_cents",
        "fees_cents",
        "net_cents",
        "updated_at",
    )
    list_filter = ("channel", "status", "currency")
    search_fields = ("external_order_id", "channel__name")
    ordering = ("-created_at",)

