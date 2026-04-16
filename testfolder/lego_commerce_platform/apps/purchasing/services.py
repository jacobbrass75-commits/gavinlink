from decimal import Decimal
from django.utils import timezone
from typing import Iterable

from django.db import transaction

from apps.inventory.models import InventoryEvent, InventoryLot
from apps.inventory.services import record_inventory_event

from .models import Purchase, PurchaseLine


@transaction.atomic
def intake_purchase(
    *,
    purchase: Purchase,
    line_items: Iterable[dict],
    location=None,
    received_at=None,
):
    created_lines: list[PurchaseLine] = []
    for line_data in line_items:
        item = line_data["item"]
        quantity = int(line_data["quantity"])
        unit_cost = Decimal(str(line_data.get("unit_cost", "0")))
        line_notes = line_data.get("notes", "")
        line = PurchaseLine.objects.create(
            purchase=purchase,
            item=item,
            quantity=quantity,
            unit_cost=unit_cost,
            line_total_cost=Decimal(str(line_data.get("line_total_cost", unit_cost * quantity))),
            notes=line_notes,
            metadata=line_data.get("metadata") or {},
        )
        lot = InventoryLot.objects.create(
            item=item,
            purchase_line=line,
            location=location or line_data.get("location"),
            lot_code=line_data.get("lot_code", ""),
            acquired_quantity=quantity,
            unit_cost=unit_cost,
            extended_cost=Decimal(str(line_data.get("extended_cost", unit_cost * quantity))),
            received_at=received_at or line_data.get("received_at") or purchase.purchased_at,
            notes=line_notes,
            metadata=line_data.get("metadata") or {},
        )
        record_inventory_event(
            item=item,
            lot=lot,
            purchase_line=line,
            event_type=InventoryEvent.EventType.RECEIVED,
            quantity_delta=quantity,
            occurred_at=received_at or purchase.purchased_at,
            reference_type="purchase",
            reference_id=str(purchase.pk),
            idempotency_key=f"purchase-line-receipt:{line.pk}",
            notes=line_notes,
            metadata=line_data.get("metadata") or {},
        )
        created_lines.append(line)
    purchase.status = Purchase.Status.RECEIVED
    purchase.save(update_fields=["status", "updated_at"])
    return created_lines


def create_purchase(
    *,
    source_name: str,
    source_reference: str = "",
    purchased_at=None,
    status: str = Purchase.Status.DRAFT,
    currency: str = "USD",
    merchandise_cost=0,
    shipping_cost=0,
    fees_cost=0,
    notes: str = "",
    metadata=None,
):
    return Purchase.objects.create(
        source_name=source_name,
        source_reference=source_reference,
        purchased_at=purchased_at or timezone.now(),
        status=status,
        currency=currency,
        merchandise_cost=merchandise_cost,
        shipping_cost=shipping_cost,
        fees_cost=fees_cost,
        notes=notes,
        metadata=metadata or {},
    )
