import uuid

from django.db import models
from django.utils import timezone
from django.core.exceptions import ValidationError


class InventoryLocation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code = models.CharField(max_length=64, unique=True)
    name = models.CharField(max_length=255)
    active = models.BooleanField(default=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["code"]

    def __str__(self) -> str:
        return self.code


class InventoryLot(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    item = models.ForeignKey(
        "catalog.CatalogItem",
        on_delete=models.PROTECT,
        related_name="inventory_lots",
    )
    purchase_line = models.OneToOneField(
        "purchasing.PurchaseLine",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="inventory_lot",
    )
    location = models.ForeignKey(
        InventoryLocation,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="inventory_lots",
    )
    lot_code = models.CharField(max_length=80, unique=True, null=True, blank=True)
    acquired_quantity = models.PositiveIntegerField()
    unit_cost = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    extended_cost = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    received_at = models.DateTimeField(default=timezone.now)
    notes = models.TextField(blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-received_at", "created_at"]
        indexes = [
            models.Index(fields=["item", "received_at"]),
            models.Index(fields=["location", "received_at"]),
        ]

    def __str__(self) -> str:
        return self.lot_code or f"Lot {self.pk}"


class InventoryReservation(models.Model):
    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        RELEASED = "released", "Released"
        CONSUMED = "consumed", "Consumed"
        CANCELLED = "cancelled", "Cancelled"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    item = models.ForeignKey(
        "catalog.CatalogItem",
        on_delete=models.PROTECT,
        related_name="inventory_reservations",
    )
    lot = models.ForeignKey(
        InventoryLot,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="reservations",
    )
    reservation_key = models.CharField(max_length=128, unique=True)
    reserved_quantity = models.PositiveIntegerField()
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.ACTIVE,
    )
    source_type = models.CharField(max_length=64, blank=True)
    source_reference = models.CharField(max_length=128, blank=True)
    notes = models.TextField(blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    released_at = models.DateTimeField(null=True, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["item", "status"]),
            models.Index(fields=["lot", "status"]),
        ]

    def is_active(self, as_of=None) -> bool:
        as_of = as_of or timezone.now()
        return self.status == self.Status.ACTIVE and (
            self.expires_at is None or self.expires_at > as_of
        )

    def __str__(self) -> str:
        return f"{self.reservation_key} ({self.reserved_quantity})"


class InventoryEvent(models.Model):
    class EventType(models.TextChoices):
        RECEIVED = "received", "Received"
        SOLD = "sold", "Sold"
        RETURNED = "returned", "Returned"
        DAMAGED = "damaged", "Damaged"
        ADJUSTED = "adjusted", "Adjusted"
        TRANSFERRED = "transferred", "Transferred"
        COUNTED = "counted", "Counted"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    item = models.ForeignKey(
        "catalog.CatalogItem",
        on_delete=models.PROTECT,
        related_name="inventory_events",
    )
    lot = models.ForeignKey(
        InventoryLot,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="inventory_events",
    )
    reservation = models.ForeignKey(
        InventoryReservation,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="inventory_events",
    )
    purchase_line = models.ForeignKey(
        "purchasing.PurchaseLine",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="inventory_events",
    )
    event_type = models.CharField(max_length=24, choices=EventType.choices)
    quantity_delta = models.IntegerField()
    idempotency_key = models.CharField(max_length=128, null=True, blank=True, unique=True)
    occurred_at = models.DateTimeField(default=timezone.now, db_index=True)
    reference_type = models.CharField(max_length=64, blank=True)
    reference_id = models.CharField(max_length=128, blank=True)
    notes = models.TextField(blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-occurred_at", "-created_at"]
        indexes = [
            models.Index(fields=["item", "occurred_at"]),
            models.Index(fields=["lot", "occurred_at"]),
            models.Index(fields=["event_type", "occurred_at"]),
            models.Index(fields=["reference_type", "reference_id"]),
        ]

    def clean(self):
        if self.quantity_delta == 0:
            raise ValidationError("Inventory events must change quantity.")

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise ValueError("InventoryEvent is append-only.")
        self.clean()
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValueError("InventoryEvent is append-only.")

    def __str__(self) -> str:
        return f"{self.event_type}:{self.quantity_delta} for {self.item_id}"
