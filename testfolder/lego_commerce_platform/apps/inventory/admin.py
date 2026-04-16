from django.contrib import admin

from .models import InventoryEvent, InventoryLocation, InventoryLot, InventoryReservation


@admin.register(InventoryLocation)
class InventoryLocationAdmin(admin.ModelAdmin):
    list_display = ("code", "name", "active", "created_at")
    list_filter = ("active",)
    search_fields = ("code", "name")


@admin.register(InventoryLot)
class InventoryLotAdmin(admin.ModelAdmin):
    list_display = (
        "lot_code",
        "item",
        "acquired_quantity",
        "unit_cost",
        "extended_cost",
        "location",
        "received_at",
    )
    list_filter = ("location", "received_at")
    search_fields = ("lot_code", "item__internal_sku", "item__title")
    readonly_fields = ("id", "created_at", "updated_at")


@admin.register(InventoryReservation)
class InventoryReservationAdmin(admin.ModelAdmin):
    list_display = (
        "reservation_key",
        "item",
        "reserved_quantity",
        "status",
        "source_type",
        "source_reference",
        "expires_at",
        "created_at",
    )
    list_filter = ("status", "source_type")
    search_fields = ("reservation_key", "source_reference", "item__internal_sku")
    readonly_fields = ("id", "created_at", "updated_at", "released_at")


@admin.register(InventoryEvent)
class InventoryEventAdmin(admin.ModelAdmin):
    list_display = (
        "event_type",
        "item",
        "quantity_delta",
        "lot",
        "reservation",
        "purchase_line",
        "occurred_at",
    )
    list_filter = ("event_type", "occurred_at")
    search_fields = (
        "item__internal_sku",
        "item__title",
        "reference_type",
        "reference_id",
        "notes",
    )
    readonly_fields = ("id", "created_at")

